# YSFLIGHT platform layer for ysflight-xrift (Emscripten, host-driven).
# The directory/file names mirror ysflight-web's src/port so the engine
# fork's CMake (add_subdirectory(${YSFLIGHT_WEB_PORT_DIR}/platform_emscripten))
# needs no change.

set(TARGET_NAME ysflight_platform_emscripten)

add_library(${TARGET_NAME}
	fsplatform_emscripten.cpp
	${CMAKE_SOURCE_DIR}/sounddll/yswavfile/yswavfile.cpp
	fsairsound_emscripten.cpp
)

target_include_directories(${TARGET_NAME} PRIVATE
	${CMAKE_SOURCE_DIR}
	${CMAKE_SOURCE_DIR}/platform/common
	${CMAKE_SOURCE_DIR}/sounddll
	${CMAKE_SOURCE_DIR}/sounddll/yswavfile
	${CMAKE_SOURCE_DIR}/voicedll
)

target_link_libraries(${TARGET_NAME}
	geblkernel
	geblgl
	ysclass
	ysscenery_dnm
	ysflight_common
	ysflight_core
	fssimplewindow
)
