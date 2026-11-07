/* ////////////////////////////////////////////////////////////

File Name: fslazywindow_emscripten.cpp

Host-driven fslazywindow driver for ysflight-xrift.

Unlike ysflight-web's driver (which owns requestAnimationFrame through
emscripten_set_main_loop), this one owns NO loop: main() initialises the
application and returns with the runtime kept alive (-sEXIT_RUNTIME=0),
and the host (an XRift world running inside React Three Fiber) calls

  YsfxInterval()  once per host frame  -> simulation step
  YsfxDraw()      once per eye/view    -> one engine draw pass

The per-eye camera comes from the host through fsvr.h's eye-data block
with the external-view flag raised (FsVrExternalViewDataPointer).

Copyright (c) 2026 ysflight-xrift contributors.
Follows the same BSD-style license as fslazywindow itself.

//////////////////////////////////////////////////////////// */

#include <emscripten.h>

#include <fssimplewindow.h>
#include <fslazywindow.h>

#include "graphics/common/fsvr.h"

static bool busy=false;      // Re-entry guard
static int terminated=0;
static double tickMsAvg=0.0;
static double drawMsAvg=0.0;

static void IntervalCallBack(void *)
{
	if(true!=busy)
	{
		auto appPtr=FsLazyWindowApplicationBase::GetApplication();
		if(nullptr!=appPtr)
		{
			busy=true;
			appPtr->Interval();
			busy=false;
		}
	}
}

static void NeedRedrawCallBack(void *)
{
	auto appPtr=FsLazyWindowApplicationBase::GetApplication();
	if(nullptr!=appPtr)
	{
		appPtr->Draw();
	}
}

static bool UserWantToCloseProgram(void *)
{
	auto appPtr=FsLazyWindowApplicationBase::GetApplication();
	if(nullptr!=appPtr && true==appPtr->UserWantToCloseProgram())
	{
		appPtr->BeforeTerminate();
		return true;
	}
	return false;
}

static void CheckTerminate(FsLazyWindowApplicationBase *appPtr)
{
	if(0==terminated && (0==FsCheckWindowOpen() || true==appPtr->MustTerminate()))
	{
		appPtr->BeforeTerminate();
		terminated=1;
	}
}

extern "C" int EMSCRIPTEN_KEEPALIVE YsfxTerminated(void)
{
	return terminated;
}

extern "C" double EMSCRIPTEN_KEEPALIVE YsfxGetIntervalMs(void)
{
	return tickMsAvg;
}

extern "C" double EMSCRIPTEN_KEEPALIVE YsfxGetDrawMs(void)
{
	return drawMsAvg;
}

/*! One simulation step.  Call once per host frame. */
extern "C" void EMSCRIPTEN_KEEPALIVE YsfxInterval(void)
{
	auto appPtr=FsLazyWindowApplicationBase::GetApplication();
	if(nullptr==appPtr || 0!=terminated || true==busy)
	{
		return;
	}
	CheckTerminate(appPtr);
	if(0!=terminated)
	{
		return;
	}

	const double t0=emscripten_get_now();
	FsPollDevice();
	busy=true;
	appPtr->Interval();
	busy=false;
	CheckTerminate(appPtr);

	const double ms=emscripten_get_now()-t0;
	tickMsAvg=(0.0==tickMsAvg ? ms : tickMsAvg*0.95+ms*0.05);
	FsVrPerfAccumulate(0,ms);
}

/*! One draw pass with the GL state the host currently has bound.  The host
    sets the eye block (fsvr.h) before calling.  Returns 0 when nothing was
    drawn (terminated / busy). */
extern "C" int EMSCRIPTEN_KEEPALIVE YsfxDraw(void)
{
	auto appPtr=FsLazyWindowApplicationBase::GetApplication();
	if(nullptr==appPtr || 0!=terminated || true==busy)
	{
		return 0;
	}
	const double t0=emscripten_get_now();
	busy=true;
	appPtr->Draw();
	busy=false;
	const double ms=emscripten_get_now()-t0;
	drawMsAvg=(0.0==drawMsAvg ? ms : drawMsAvg*0.95+ms*0.05);
	FsVrPerfAccumulate(1,ms);
	return 1;
}

int main(int ac,char *av[])
{
	auto appPtr=FsLazyWindowApplicationBase::GetApplication();

	appPtr->BeforeEverything(ac,av);

	FsOpenWindowOption owo;
	owo.useDoubleBuffer=true;
	appPtr->GetOpenWindowOption(owo);

	FsOpenWindow(owo);
	appPtr->Initialize(ac,av);

	// Memo: Don't register call backs before Initialize.
	FsRegisterIntervalCallBack(IntervalCallBack,nullptr);
	FsRegisterOnPaintCallBack(NeedRedrawCallBack,nullptr);
	FsRegisterCloseWindowCallBack(UserWantToCloseProgram,nullptr);

	// No main loop: the host drives YsfxInterval/YsfxDraw.  The runtime stays
	// alive because the link uses -sEXIT_RUNTIME=0.
	return 0;
}
