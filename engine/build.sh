#!/usr/bin/env bash
# Build the YSFLIGHT engine as a host-driven WebAssembly module for ysflight-xrift.
#
#   engine/build.sh            # configure + build -> engine/dist/
#
# Prerequisites: Emscripten (emcmake/emcc on PATH), CMake 3.20+.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/engine/build"
DIST_DIR="$ROOT/engine/dist"
PORT_DIR="$ROOT/engine/port"
RUNTIME_DIR="$ROOT/upstream/YSFLIGHT/runtime"

# First checkout only: never reset a submodule someone is working in.
for sm in upstream/YSFLIGHT upstream/public; do
    if [[ ! -f "$ROOT/$sm/.git" && ! -d "$ROOT/$sm/.git" ]]; then
        git -C "$ROOT" submodule update --init --depth 1 "$sm"
    fi
done

# Everything the engine exports to the host (fsvr.h blocks + Ysfx* entry points,
# the latter are EMSCRIPTEN_KEEPALIVE and exported automatically).
EXPORTED_FUNCTIONS="_main,_malloc,_free,_FsVrSetActive,_FsVrIsActive,_FsVrEyeDataPointer,_FsVrExternalViewDataPointer,_FsVrPlayerPoseDataPointer,_FsVrPlayerVisualDataPointer,_FsVrSetFrameTimeMs,_FsVrFrameTimeMs,_FsVrAbiVersion,_FsVrControlDataPointer,_FsVrHandPoseDataPointer,_FsVrAircraftStateDataPointer,_FsVrConsumeSimDrawnFrames,_FsVrPerfDataPointer,_FsVrHudDataPointer,_FsVrMenuDataPointer,_FsVrSetMultiview,_FsVrIsMultiview,_FsVrNetRequestJoin,_FsVrNetRequestLeave,_FsVrNetStateDataPointer,_FsVrAirListDataPointer,_FsVrAirListIdentifier,_FsVrAirListName,_FsVrFlightDataPointer,_FsVrLobbyAirCount,_FsVrLobbyAirName,_FsVrLobbyStpCount,_FsVrLobbyStpName,_FsVrLobbyStpPos,_FsVrLobbyStpHeading,_FsVrLobbyFieldCount,_FsVrLobbyFieldName,_FsVrGroundProbeDataPointer"
RUNTIME_METHODS="FS,ENV,GL,AL,HEAPF32,HEAP8,HEAPU8,UTF8ToString,stringToUTF8,ccall,cwrap,addRunDependency,removeRunDependency"
INCOMING="ENVIRONMENT,arguments,canvas,locateFile,onRuntimeInitialized,preRun,postRun,print,printErr,onAbort,preinitializedWebGLContext,noInitialRun,instantiateWasm"

# Semicolon-separated so CMake receives a list.
LINK_OPTIONS="-sFULL_ES2=1"
LINK_OPTIONS+=";-sMIN_WEBGL_VERSION=2;-sMAX_WEBGL_VERSION=2"
LINK_OPTIONS+=";-sGL_PREINITIALIZED_CONTEXT=1"
LINK_OPTIONS+=";-sASSERTIONS=0"
LINK_OPTIONS+=";-sALLOW_MEMORY_GROWTH=1;-sSTACK_SIZE=8388608"
LINK_OPTIONS+=";-sFORCE_FILESYSTEM=1;-sEXIT_RUNTIME=0;-sENVIRONMENT=web"
LINK_OPTIONS+=";-sMODULARIZE=1;-sEXPORT_ES6=1;-sEXPORT_NAME=createYsflightXrift"
LINK_OPTIONS+=";-sEXPORTED_FUNCTIONS=${EXPORTED_FUNCTIONS}"
LINK_OPTIONS+=";-sEXPORTED_RUNTIME_METHODS=${RUNTIME_METHODS}"
LINK_OPTIONS+=";-sINCOMING_MODULE_JS_API=${INCOMING}"
LINK_OPTIONS+=";-lopenal"
LINK_OPTIONS+=";SHELL:--preload-file ${RUNTIME_DIR}@/ysflight"

emcmake cmake -S "$ROOT/upstream/YSFLIGHT/src" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DYSFLIGHT_WEB_PORT_DIR="$PORT_DIR" \
    -DYSFLIGHT_EMSCRIPTEN_LINK_OPTIONS="$LINK_OPTIONS" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_EXE_LINKER_FLAGS="-O2"

NPROC=$( (nproc 2>/dev/null || sysctl -n hw.ncpu) )
cmake --build "$BUILD_DIR" --target ysflight32_gl2 -j"$NPROC"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
cp "$BUILD_DIR/main/ysflight32_gl2.js" "$BUILD_DIR/main/ysflight32_gl2.wasm" "$BUILD_DIR/main/ysflight32_gl2.data" "$DIST_DIR/"

# Which fork commit this binary is (the binaries themselves are not tracked):
# the world logs it at boot and the test beacon carries it, so a deployed
# world version can be traced to engine source.
FORK="$ROOT/upstream/YSFLIGHT"
FORK_REV="$(git -C "$FORK" rev-parse --short HEAD)"
if [[ -n "$(git -C "$FORK" status --porcelain --untracked-files=no)" ]]; then FORK_REV+="-dirty"; fi
# An ES module, not JSON: the world reads it with import(), the way it loads the
# glue (XRift's upload check refuses fetch() without a network permission).
printf 'export default {"fork":"%s","built":"%s"}\n' "$FORK_REV" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIST_DIR/build.js"

# Install into the world's static files (what `npm run dev` and the upload serve).
"$ROOT/world/scripts-sync-engine.sh"
echo "Done. ($FORK_REV)"
