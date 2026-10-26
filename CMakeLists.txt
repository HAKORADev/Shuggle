cmake_minimum_required(VERSION 3.16)
project(Shuggle VERSION 0.5.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(CURL REQUIRED)

# ── core library (platform-identical, GUI-independent) ────────────────────────
add_library(shuggle_core STATIC
    src/core/util.cpp
    src/core/http.cpp
    src/core/kaggle_client.cpp
    src/core/token_manager.cpp
    src/core/settings.cpp
    src/core/chat_store.cpp
    src/core/system_prompt.cpp
    src/core/memory_handler.cpp
    src/core/notebook_template.cpp
    src/core/search_pipeline.cpp
    src/core/engine.cpp
    src/common/banner.cpp
)
target_include_directories(shuggle_core PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)
target_link_libraries(shuggle_core PUBLIC CURL::libcurl)
target_compile_options(shuggle_core PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra>
)

# ── CLI ───────────────────────────────────────────────────────────────────────
add_executable(shuggle-cli src/cli/main_cli.cpp)
target_link_libraries(shuggle-cli PRIVATE shuggle_core)

# ── GUI (Qt6) ─────────────────────────────────────────────────────────────────
option(SHUGGLE_BUILD_GUI "Build the Qt6 GUI" ON)
if(SHUGGLE_BUILD_GUI)
    # Pre-create Qt's WrapOpenGL target the way Qt's own Linux branch does
    # (GLVND-only). Avoids FindWrapOpenGL falling into the legacy OpenGL::GL
    # branch on systems without legacy GL dev files.
    find_package(OpenGL QUIET COMPONENTS OpenGL)
    if(OpenGL_FOUND AND NOT TARGET WrapOpenGL::WrapOpenGL)
        add_library(WrapOpenGL::WrapOpenGL INTERFACE IMPORTED)
        target_link_libraries(WrapOpenGL::WrapOpenGL INTERFACE OpenGL::OpenGL)
    endif()
    find_package(Qt6 COMPONENTS Widgets QUIET)
    if(Qt6_FOUND)
        enable_language(CXX)
        set(CMAKE_AUTOMOC ON)
        set(CMAKE_AUTORCC ON)
        set(CMAKE_AUTOUIC ON)
        add_executable(shuggle
            src/gui/main_gui.cpp
            src/gui/theme.cpp
            src/gui/main_window.cpp
            src/gui/chat_view.cpp
            src/gui/sidebar.cpp
            src/gui/settings_dialog.cpp
            src/gui/token_dialog.cpp
            src/gui/terminal_panel.cpp
            src/gui/resources.qrc
        )
        target_include_directories(shuggle PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
        target_link_libraries(shuggle PRIVATE shuggle_core Qt6::Widgets)
        # aqt-distributed Qt6Gui leaves egl* symbols unresolved for the final
        # executable link — resolve against system EGL when present (CI) or the
        # local shim (dev sandbox)
        find_library(SHUGGLE_EGL_LIB NAMES EGL)
        if(SHUGGLE_EGL_LIB)
            target_link_libraries(shuggle PRIVATE ${SHUGGLE_EGL_LIB})
        endif()
        if(WIN32)
            target_sources(shuggle PRIVATE src/gui/web_runtime_win.cpp)
            target_compile_definitions(shuggle PRIVATE SHUGGLE_WEB_WIN)
            if(SHUGGLE_WEBVIEW2_INCLUDE)
                target_include_directories(shuggle PRIVATE ${SHUGGLE_WEBVIEW2_INCLUDE})
            endif()
            if(SHUGGLE_WEBVIEW2_LIB)
                target_link_directories(shuggle PRIVATE ${SHUGGLE_WEBVIEW2_LIB})
            endif()
            target_link_libraries(shuggle PRIVATE WebView2LoaderStatic user32 gdi32 ole32 shell32 shlwapi)
        else()
            target_sources(shuggle PRIVATE src/gui/web_runtime_linux.cpp)
            # web helper runs out-of-process via WebKitGTK when present
            find_package(PkgConfig QUIET)
            if(PkgConfig_FOUND)
                pkg_check_modules(WEBKIT QUIET webkit2gtk-4.1)
                if(WEBKIT_FOUND)
                    add_executable(shuggle-web src/gui/web_helper_webkit.cpp)
                    target_include_directories(shuggle-web PRIVATE ${WEBKIT_INCLUDE_DIRS})
                    target_link_libraries(shuggle-web PRIVATE ${WEBKIT_LIBRARIES})
                    target_compile_definitions(shuggle PRIVATE SHUGGLE_WEB_HELPER="shuggle-web")
                endif()
            endif()
        endif()
        if(WIN32)
            target_compile_definitions(shuggle PRIVATE SHUGGLE_VERSION="${PROJECT_VERSION}")
        endif()
        message(STATUS "Qt6 found — building GUI")
    else()
        message(STATUS "Qt6 NOT found — building core + CLI only")
    endif()
endif()

install(TARGETS shuggle-cli RUNTIME DESTINATION .)
