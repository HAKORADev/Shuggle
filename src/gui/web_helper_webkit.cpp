// Shuggle — web_helper_webkit.cpp
// Tiny standalone WebKitGTK window: `shuggle-web <url>`. Built only when
// libwebkit2gtk is found — keeps the main binary free of GTK/WebKit deps.
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

int main(int argc, char** argv) {
    if (argc < 2) return 2;
    gtk_init(&argc, &argv);
    GtkWidget* win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_default_size(GTK_WINDOW(win), 1100, 780);
    gtk_window_set_title(GTK_WINDOW(win), "Shuggle — browser");
    GtkWidget* view = webkit_web_view_new();
    WebKitSettings* settings = webkit_web_view_get_settings(WEBKIT_WEB_VIEW(view));
    webkit_settings_set_javascript_can_open_windows_automatically(settings, TRUE);
    gtk_container_add(GTK_CONTAINER(win), view);
    webkit_web_view_load_uri(WEBKIT_WEB_VIEW(view), argv[1]);
    g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), nullptr);
    gtk_widget_show_all(win);
    gtk_main();
    return 0;
}
