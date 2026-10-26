// Shuggle — web_runtime_win.cpp
// Windows backend: WebView2 in a native top-level window (no QtWebEngine).
// Uses the WebView2 loader (static) + COM interfaces. Edge binaries are shared
// with the system Edge install automatically by the WebView2 runtime.
#include <windows.h>
#include <wrl/client.h>

#include <cstdio>
#include <string>

#include <ShlObj.h>

#include "web_runtime.h"
#include "WebView2.h"

#ifndef NDEBUG
#pragma comment(lib, "user32.lib")
#endif

using namespace Microsoft::WRL;

namespace shuggle {

namespace {

LRESULT CALLBACK WebWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_SIZE: {
            // keep controller bounds in sync
            auto* controller =
                *reinterpret_cast<ICoreWebView2Controller**>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
            if (controller) {
                RECT rc;
                GetClientRect(hwnd, &rc);
                controller->put_Bounds(rc);
            }
            return 0;
        }
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(hwnd, msg, wp, lp);
    }
}

class WebEnvHandler : public ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler {
public:
    explicit WebEnvHandler(HWND hwnd, const std::wstring& url)
        : hwnd_(hwnd), url_(url), ref_(1) {}
    // IUnknown
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override {
        if (riid == __uuidof(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler) ||
            riid == __uuidof(IUnknown)) {
            *out = static_cast<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*>(this);
            AddRef();
            return S_OK;
        }
        *out = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG r = --ref_;
        if (!r) delete this;
        return r;
    }
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result,
                                     ICoreWebView2Environment* env) override {
        if (FAILED(result) || !env) return result;
        ControllerHandler* ch = new ControllerHandler(hwnd_, url_);
        env->CreateCoreWebView2Controller(hwnd_, ch);
        return S_OK;
    }

    class ControllerHandler : public ICoreWebView2CreateCoreWebView2ControllerCompletedHandler {
    public:
        ControllerHandler(HWND hwnd, const std::wstring& url) : hwnd_(hwnd), url_(url), ref_(1) {}
        HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override {
            if (riid == __uuidof(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler) ||
                riid == __uuidof(IUnknown)) {
                *out = static_cast<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler*>(this);
                AddRef();
                return S_OK;
            }
            *out = nullptr;
            return E_NOINTERFACE;
        }
        ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
        ULONG STDMETHODCALLTYPE Release() override {
            ULONG r = --ref_;
            if (!r) delete this;
            return r;
        }
        HRESULT STDMETHODCALLTYPE Invoke(HRESULT result,
                                         ICoreWebView2Controller* controller) override {
            if (FAILED(result) || !controller) {
                PostMessageW(hwnd_, WM_QUIT, 0, 0);
                return result;
            }
            ICoreWebView2* web = nullptr;
            controller->get_CoreWebView2(&web);
            if (web) {
                web->Navigate(url_.c_str());
                web->Release();
            }
            SetWindowLongPtrW(hwnd_, GWLP_USERDATA, (LONG_PTR)controller);
            ShowWindow(hwnd_, SW_SHOW);
            return S_OK;
        }
    private:
        HWND hwnd_;
        std::wstring url_;
        ULONG ref_;
    };

private:
    HWND hwnd_;
    std::wstring url_;
    ULONG ref_;
};

}  // namespace

bool open_internal_browser(const std::string& url, bool edge_data, QWidget* parent) {
    (void)parent;
    // window
    WNDCLASSW wc = {};
    wc.lpfnWndProc = WebWndProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"ShuggleWebView";
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    RegisterClassW(&wc);
    HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"Shuggle — browser",
                                WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 1100, 780,
                                nullptr, nullptr, wc.hInstance, nullptr);
    if (!hwnd) return false;

    // user data folder: default = app folder copy; opt-in = edge-shared location
    wchar_t udf[MAX_PATH];
    std::wstring user_data;
    if (edge_data) {
        wchar_t* local = nullptr;
        if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local))) {
            user_data = std::wstring(local) + L"\\Microsoft\\Edge\\ShuggleWebViewShare";
            CoTaskMemFree(local);
        }
    }
    if (user_data.empty()) {
        GetModuleFileNameW(nullptr, udf, MAX_PATH);
        std::wstring exe_dir = udf;
        size_t pos = exe_dir.find_last_of(L"\\/");
        if (pos != std::wstring::npos) exe_dir = exe_dir.substr(0, pos);
        user_data = exe_dir + L"\\shuggle-data\\webview";
    }

    std::wstring wurl(url.begin(), url.end());
    auto* handler = new WebEnvHandler(hwnd, wurl);
    HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
        nullptr, user_data.c_str(), nullptr, handler);
    if (FAILED(hr)) {
        handler->Release();
        DestroyWindow(hwnd);
        return false;
    }

    // local message pump for this browser window
    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
        if (IsWindowVisible(hwnd) && !IsWindow(hwnd)) break;
    }
    return true;
}

}  // namespace shuggle
