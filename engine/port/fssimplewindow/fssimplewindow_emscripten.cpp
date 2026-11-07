/* ////////////////////////////////////////////////////////////

File Name: fssimplewindow_emscripten.cpp

fssimplewindow back-end for ysflight-xrift: a HOSTED window.

The engine draws into a WebGL 2 context that already exists and belongs to
the host renderer (three.js inside an XRift world).  The host passes it in
as Module.preinitializedWebGLContext and the canvas as Module.canvas, so
Emscripten's GL layer wraps the existing context instead of creating one.
No DOM event listeners are installed: the host forwards keyboard input
through the Ysfx* entry points at the bottom of this file, and the window
size is whatever the host says it is.

Derived from ysflight-web's fssimplewindow_emscripten.cpp.
Copyright (c) 2026 ysflight-xrift contributors.
Follows the same BSD-style license as fssimplewindow itself.

//////////////////////////////////////////////////////////// */

#include <emscripten.h>
#include <emscripten/html5.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>

#include <fssimplewindow.h>

// ----------------------------------------------------------------------------
// State

#define NKEYBUF 256

static int keyBuffer[NKEYBUF];
static int nKeyBufUsed=0;
static int charBuffer[NKEYBUF];
static int nCharBufUsed=0;

class FsMouseEventLog
{
public:
	int eventType,lb,mb,rb,mx,my;
};

#define NEVTBUF 256
static int nMosBufUsed=0;
static FsMouseEventLog mosBuffer[NEVTBUF];
static FsMouseEventLog lastKnownMos={FSMOUSEEVENT_NONE,0,0,0,0,0};

static char keyState[FSKEY_NUM_KEYCODE];

static int winWid=1280,winHei=720;
static int windowOpen=0;
static int exposure=0;

static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE webglContext=0;

static const char *CANVAS_SELECTOR="#canvas";

// ----------------------------------------------------------------------------
// Key mapping: KeyboardEvent.code -> FSKEY

class FsKeyCodeMapping
{
public:
	const char *code;
	int fskey;
};

static const FsKeyCodeMapping keyCodeMapping[]=
{
	{"Space",FSKEY_SPACE},
	{"Digit0",FSKEY_0},{"Digit1",FSKEY_1},{"Digit2",FSKEY_2},{"Digit3",FSKEY_3},{"Digit4",FSKEY_4},
	{"Digit5",FSKEY_5},{"Digit6",FSKEY_6},{"Digit7",FSKEY_7},{"Digit8",FSKEY_8},{"Digit9",FSKEY_9},
	{"KeyA",FSKEY_A},{"KeyB",FSKEY_B},{"KeyC",FSKEY_C},{"KeyD",FSKEY_D},{"KeyE",FSKEY_E},
	{"KeyF",FSKEY_F},{"KeyG",FSKEY_G},{"KeyH",FSKEY_H},{"KeyI",FSKEY_I},{"KeyJ",FSKEY_J},
	{"KeyK",FSKEY_K},{"KeyL",FSKEY_L},{"KeyM",FSKEY_M},{"KeyN",FSKEY_N},{"KeyO",FSKEY_O},
	{"KeyP",FSKEY_P},{"KeyQ",FSKEY_Q},{"KeyR",FSKEY_R},{"KeyS",FSKEY_S},{"KeyT",FSKEY_T},
	{"KeyU",FSKEY_U},{"KeyV",FSKEY_V},{"KeyW",FSKEY_W},{"KeyX",FSKEY_X},{"KeyY",FSKEY_Y},
	{"KeyZ",FSKEY_Z},
	{"Escape",FSKEY_ESC},
	{"F1",FSKEY_F1},{"F2",FSKEY_F2},{"F3",FSKEY_F3},{"F4",FSKEY_F4},{"F5",FSKEY_F5},{"F6",FSKEY_F6},
	{"F7",FSKEY_F7},{"F8",FSKEY_F8},{"F9",FSKEY_F9},{"F10",FSKEY_F10},{"F11",FSKEY_F11},{"F12",FSKEY_F12},
	{"PrintScreen",FSKEY_PRINTSCRN},
	{"CapsLock",FSKEY_CAPSLOCK},
	{"ScrollLock",FSKEY_SCROLLLOCK},
	{"Pause",FSKEY_PAUSEBREAK},
	{"Backspace",FSKEY_BS},
	{"Tab",FSKEY_TAB},
	{"Enter",FSKEY_ENTER},
	{"ShiftLeft",FSKEY_SHIFT},{"ShiftRight",FSKEY_SHIFT},
	{"ControlLeft",FSKEY_CTRL},{"ControlRight",FSKEY_CTRL},
	{"AltLeft",FSKEY_ALT},{"AltRight",FSKEY_ALT},
	{"Insert",FSKEY_INS},
	{"Delete",FSKEY_DEL},
	{"Home",FSKEY_HOME},
	{"End",FSKEY_END},
	{"PageUp",FSKEY_PAGEUP},
	{"PageDown",FSKEY_PAGEDOWN},
	{"ArrowUp",FSKEY_UP},
	{"ArrowDown",FSKEY_DOWN},
	{"ArrowLeft",FSKEY_LEFT},
	{"ArrowRight",FSKEY_RIGHT},
	{"NumLock",FSKEY_NUMLOCK},
	{"Backquote",FSKEY_TILDA},
	{"Minus",FSKEY_MINUS},
	{"Equal",FSKEY_PLUS},
	{"BracketLeft",FSKEY_LBRACKET},
	{"BracketRight",FSKEY_RBRACKET},
	{"Backslash",FSKEY_BACKSLASH},
	{"Semicolon",FSKEY_SEMICOLON},
	{"Quote",FSKEY_SINGLEQUOTE},
	{"Comma",FSKEY_COMMA},
	{"Period",FSKEY_DOT},
	{"Slash",FSKEY_SLASH},
	{"Numpad0",FSKEY_TEN0},{"Numpad1",FSKEY_TEN1},{"Numpad2",FSKEY_TEN2},{"Numpad3",FSKEY_TEN3},
	{"Numpad4",FSKEY_TEN4},{"Numpad5",FSKEY_TEN5},{"Numpad6",FSKEY_TEN6},{"Numpad7",FSKEY_TEN7},
	{"Numpad8",FSKEY_TEN8},{"Numpad9",FSKEY_TEN9},
	{"NumpadDecimal",FSKEY_TENDOT},
	{"NumpadDivide",FSKEY_TENSLASH},
	{"NumpadMultiply",FSKEY_TENSTAR},
	{"NumpadSubtract",FSKEY_TENMINUS},
	{"NumpadAdd",FSKEY_TENPLUS},
	{"NumpadEnter",FSKEY_TENENTER},
	{"ContextMenu",FSKEY_CONTEXT},
	{"Convert",FSKEY_CONVERT},
	{"NonConvert",FSKEY_NONCONVERT},
	{"KanaMode",FSKEY_KANA},
	{"IntlRo",FSKEY_RO},
	{nullptr,FSKEY_NULL}
};

static int FsKeyCodeFromDomCode(const char code[])
{
	for(int i=0; nullptr!=keyCodeMapping[i].code; ++i)
	{
		if(0==strcmp(code,keyCodeMapping[i].code))
		{
			return keyCodeMapping[i].fskey;
		}
	}
	return FSKEY_NULL;
}

// ----------------------------------------------------------------------------
// Event queue helpers

static void PushMouseEvent(int evt,int lb,int mb,int rb,int mx,int my)
{
	if(nMosBufUsed<NEVTBUF)
	{
		mosBuffer[nMosBufUsed].eventType=evt;
		mosBuffer[nMosBufUsed].lb=lb;
		mosBuffer[nMosBufUsed].mb=mb;
		mosBuffer[nMosBufUsed].rb=rb;
		mosBuffer[nMosBufUsed].mx=mx;
		mosBuffer[nMosBufUsed].my=my;
		++nMosBufUsed;
	}
	lastKnownMos.eventType=evt;
	lastKnownMos.lb=lb;
	lastKnownMos.mb=mb;
	lastKnownMos.rb=rb;
	lastKnownMos.mx=mx;
	lastKnownMos.my=my;
}

void FsPushKey(int fskey)
{
	if(nKeyBufUsed<NKEYBUF)
	{
		keyBuffer[nKeyBufUsed++]=fskey;
	}
}

void FsPushChar(int c)
{
	if(nCharBufUsed<NKEYBUF)
	{
		charBuffer[nCharBufUsed++]=c;
	}
}

// ----------------------------------------------------------------------------
// Host entry points (called from JS)

/*! Keyboard: KeyboardEvent.code, down=1/0.  Returns the FSKEY code (0 if
    unmapped) so the host can decide whether to preventDefault. */
extern "C" int EMSCRIPTEN_KEEPALIVE YsfxKeyByCode(const char code[],int down)
{
	const int fskey=FsKeyCodeFromDomCode(code);
	if(FSKEY_NULL!=fskey && fskey<FSKEY_NUM_KEYCODE)
	{
		if(0!=down)
		{
			if(0==keyState[fskey])
			{
				FsPushKey(fskey);
			}
			keyState[fskey]=1;
		}
		else
		{
			keyState[fskey]=0;
		}
	}
	return fskey;
}

/*! Keyboard: a typed character (KeyboardEvent.key of length 1). */
extern "C" void EMSCRIPTEN_KEEPALIVE YsfxChar(int c)
{
	FsPushChar(c);
}

/*! Release every key (host lost focus / entered a text field). */
extern "C" void EMSCRIPTEN_KEEPALIVE YsfxReleaseAllKeys(void)
{
	memset(keyState,0,sizeof(keyState));
}

/*! Mouse in window pixels, top-left origin.  eventType: FSMOUSEEVENT_*. */
extern "C" void EMSCRIPTEN_KEEPALIVE YsfxMouse(int eventType,int lb,int mb,int rb,int mx,int my)
{
	PushMouseEvent(eventType,lb,mb,rb,mx,my);
}

/*! The host's view size in pixels (the engine's notion of its window). */
extern "C" void EMSCRIPTEN_KEEPALIVE YsfxSetWindowSize(int wid,int hei)
{
	if(8<=wid && 8<=hei)
	{
		winWid=wid;
		winHei=hei;
		exposure=1;
	}
}

// ----------------------------------------------------------------------------
// Window

void FsOpenWindow(const FsOpenWindowOption &opt)
{
	if(0!=windowOpen)
	{
		return;
	}
	(void)opt; // The host's view size wins (YsfxSetWindowSize).

	if(nullptr==fsOpenGLContextCreationCallBack ||
	   true!=(*fsOpenGLContextCreationCallBack)(fsOpenGLContextCreationCallBackParam))
	{
		// Wrap the host's existing WebGL 2 context.  Emscripten's own
		// emscripten_webgl_create_context wants a DOM selector; registering
		// the context object directly keeps the host's DOM untouched.
		webglContext=(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE)EM_ASM_INT({
			var ctx=Module['preinitializedWebGLContext'];
			if(!ctx || typeof GL==='undefined' || !GL.registerContext)
			{
				return 0;
			}
			var handle=GL.registerContext(ctx,{
				majorVersion:2,minorVersion:0,
				enableExtensionsByDefault:true,
				explicitSwapControl:false,renderViaOffscreenBackBuffer:false
			});
			if(!GL.makeContextCurrent(handle))
			{
				return 0;
			}
			return handle;
		});
		if(webglContext<=0)
		{
			printf("ysflight-xrift: no host WebGL context (Module.preinitializedWebGLContext)\n");
			return;
		}
	}

	windowOpen=1;
	exposure=1;

	if(nullptr!=fsOpenGLInitializationCallBack)
	{
		(*fsOpenGLInitializationCallBack)(fsOpenGLInitializationCallBackParam);
	}
	if(nullptr!=fsAfterWindowCreationCallBack)
	{
		(*fsAfterWindowCreationCallBack)(fsAfterWindowCreationCallBackParam);
	}
}

int FsCheckWindowOpen(void)
{
	return windowOpen;
}

void FsCloseWindow(void)
{
	windowOpen=0;
}

void FsMaximizeWindow(void)
{
}
void FsUnmaximizeWindow(void)
{
}
void FsMakeFullScreen(void)
{
}
void FsResizeWindow(int,int)
{
}

// Window-size override used by the engine's VR HUD off-screen pass.
static int fsWinSizeOverrideActive=0;
static int fsWinSizeOverrideW=0;
static int fsWinSizeOverrideH=0;

extern "C" void FsSetWindowSizeOverride(int active,int w,int h)
{
	fsWinSizeOverrideActive=(0!=active ? 1 : 0);
	fsWinSizeOverrideW=w;
	fsWinSizeOverrideH=h;
}

void FsGetWindowSize(int &wid,int &hei)
{
	if(0!=fsWinSizeOverrideActive)
	{
		wid=fsWinSizeOverrideW;
		hei=fsWinSizeOverrideH;
		return;
	}
	wid=winWid;
	hei=winHei;
}

void FsGetWindowPosition(int &x0,int &y0)
{
	x0=0;
	y0=0;
}

void FsSetWindowTitle(const char [])
{
}

void FsPushOnPaintEvent(void)
{
	exposure=1;
}

void FsPollDevice(void)
{
	if(nullptr!=fsPollDeviceHook)
	{
		(*fsPollDeviceHook)(fsPollDeviceHookParam);
	}
}

void FsSleep(int)
{
	// Cannot block the browser's main thread.
}

// ----------------------------------------------------------------------------
// Timers

static bool firstTime=true;
static double timeOrigin=0.0;
static double prevTime=0.0;

long long int FsSubSecondTimer(void)
{
	const double now=emscripten_get_now();
	if(true==firstTime)
	{
		firstTime=false;
		timeOrigin=now;
		prevTime=now;
	}
	return (long long int)(now-timeOrigin);
}

long long int FsPassedTime(void)
{
	const double now=emscripten_get_now();
	if(true==firstTime)
	{
		firstTime=false;
		timeOrigin=now;
		prevTime=now;
	}
	long long int passed=(long long int)(now-prevTime);
	prevTime=now;
	if(0==passed)
	{
		passed=1;
	}
	return passed;
}

// ----------------------------------------------------------------------------
// Mouse & keyboard state

void FsGetMouseState(int &lb,int &mb,int &rb,int &mx,int &my)
{
	lb=lastKnownMos.lb;
	mb=lastKnownMos.mb;
	rb=lastKnownMos.rb;
	mx=lastKnownMos.mx;
	my=lastKnownMos.my;
}

int FsGetMouseEvent(int &lb,int &mb,int &rb,int &mx,int &my)
{
	if(0<nMosBufUsed)
	{
		const int eventType=mosBuffer[0].eventType;
		lb=mosBuffer[0].lb;
		mb=mosBuffer[0].mb;
		rb=mosBuffer[0].rb;
		mx=mosBuffer[0].mx;
		my=mosBuffer[0].my;

		--nMosBufUsed;
		for(int i=0; i<nMosBufUsed; ++i)
		{
			mosBuffer[i]=mosBuffer[i+1];
		}
		return eventType;
	}
	FsGetMouseState(lb,mb,rb,mx,my);
	return FSMOUSEEVENT_NONE;
}

void FsSetMousePosition(int,int)
{
}

void FsSwapBuffers(void)
{
	if(nullptr!=fsSwapBuffersHook &&
	   true==(*fsSwapBuffersHook)(fsSwapBuffersHookParam))
	{
		return;
	}
	// The host presents the frame.
}

int FsInkey(void)
{
	if(0<nKeyBufUsed)
	{
		const int keyCode=keyBuffer[0];
		--nKeyBufUsed;
		for(int i=0; i<nKeyBufUsed; ++i)
		{
			keyBuffer[i]=keyBuffer[i+1];
		}
		return keyCode;
	}
	return FSKEY_NULL;
}

int FsInkeyChar(void)
{
	if(0<nCharBufUsed)
	{
		const int c=charBuffer[0];
		--nCharBufUsed;
		for(int i=0; i<nCharBufUsed; ++i)
		{
			charBuffer[i]=charBuffer[i+1];
		}
		return c;
	}
	return 0;
}

int FsGetKeyState(int fsKeyCode)
{
	if(0<=fsKeyCode && fsKeyCode<FSKEY_NUM_KEYCODE)
	{
		return keyState[fsKeyCode];
	}
	return 0;
}

int FsCheckWindowExposure(void)
{
	const int e=exposure;
	exposure=0;
	return e;
}

void FsShowMouseCursor(int)
{
}

int FsIsMouseCursorVisible(void)
{
	return 1;
}

void FsChangeToProgramDir(void)
{
	// The runtime data is preloaded at /ysflight (see engine/build.sh).
	chdir("/ysflight");
}

int FsGetNumCurrentTouch(void)
{
	return 0;
}

const FsVec2i *FsGetCurrentTouch(void)
{
	return nullptr;
}

int FsEnableIME(void)
{
	return 0;
}

void FsDisableIME(void)
{
}

int FsIsNativeTextInputAvailable(void)
{
	return 0;
}

int FsOpenNativeTextInput(int,int,int,int)
{
	return 0;
}

void FsCloseNativeTextInput(void)
{
}

void FsSetNativeTextInputText(const wchar_t [])
{
}

int FsGetNativeTextInputTextLength(void)
{
	return 0;
}

void FsGetNativeTextInputText(wchar_t str[],int bufLen)
{
	if(0<bufLen)
	{
		str[0]=0;
	}
}

int FsGetNativeTextInputEvent(void)
{
	return 0;
}
