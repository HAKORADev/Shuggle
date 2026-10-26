// Shuggle — main_cli.cpp
// CLI entry: interactive mode (`shuggle cli`) + VODER-style one-line mode
// (`shuggle chat "..." session "physics" temperature 0.9`). No GUI deps.
#include <cstdio>
#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>
#include <thread>

#ifdef _WIN32
#include <io.h>
#include <winsock2.h>
#else
#include <unistd.h>
#endif

#include "../common/banner.h"
#include "../common/version.h"
#include "../core/chat_store.h"
#include "../core/engine.h"
#include "../core/memory_handler.h"
#include "../core/settings.h"
#include "../core/token_manager.h"
#include "../core/util.h"

using namespace shuggle;

static bool stdout_is_tty() {
#ifdef _WIN32
    return _isatty(_fileno(stdout)) != 0;
#else
    return isatty(fileno(stdout)) != 0;
#endif
}

static void print_err(const std::string& msg) {
    if (stdout_is_tty()) fprintf(stderr, "\033[31m✗ %s\033[0m\n", msg.c_str());
    else fprintf(stderr, "✗ %s\n", msg.c_str());
}
static void print_ok(const std::string& msg) {
    if (stdout_is_tty()) fprintf(stderr, "\033[32m✓ %s\033[0m\n", msg.c_str());
    else fprintf(stderr, "✓ %s\n", msg.c_str());
}

// ── shared plumbing ──────────────────────────────────────────────────────────

struct App {
    GlobalSettings settings;
    std::unique_ptr<TokenManager> tokens;
    std::unique_ptr<ChatStore> store;
    std::unique_ptr<MemoryHandler> memory;
    std::unique_ptr<Engine> engine;

    void init() {
        ensure_dir(app_base_dir());
        settings = GlobalSettings::load(settings_file_path());
        tokens = std::make_unique<TokenManager>(tokens_file_path());
        tokens->load();
        store = std::make_unique<ChatStore>(sessions_dir());
        memory = std::make_unique<MemoryHandler>(memory_file_path());
        memory->load();
        engine = std::make_unique<Engine>(settings, *tokens);
    }
};

static Session pick_or_create_session(App& app, const std::string& name) {
    if (!name.empty()) {
        for (auto& s : app.store->list_sessions(true)) {
            if (s.title == name) return s;
        }
    }
    Session s;
    s.id = random_hex(12);
    s.title = name.empty() ? "quick-ask" : name;
    s.created = now_epoch_seconds();
    s.updated = s.created;
    s.ever_named = true;
    return s;
}

static void seed_token_from_env(App& app) {
    // convenience: SHUGGLE_TOKEN env or ~/.kaggle/access_token (kaggle lib compatible)
    const char* env = std::getenv("SHUGGLE_TOKEN");
    std::string tok;
    if (env && *env) tok = env;
    if (tok.empty()) {
        std::string home =
#ifdef _WIN32
            std::getenv("USERPROFILE") ? std::getenv("USERPROFILE") : "";
#else
            std::getenv("HOME") ? std::getenv("HOME") : "";
#endif
        std::string p = path_join(home, ".kaggle/access_token");
        read_file(p, tok);
        tok = trim(tok);
    }
    if (!tok.empty() && !app.tokens->has_token(tok)) {
        std::string err;
        if (app.tokens->add_token(tok, "auto", err)) {
            app.tokens->save();
            print_ok("token added from env/file");
        } else {
            print_err("token rejected: " + err);
        }
    }
}

// ── one-line mode ─────────────────────────────────────────────────────────────

static int cmd_oneline(App& app, const std::vector<std::string>& args) {
    if (args.empty() || (args[0] != "chat" && args[0] != "ask")) {
        printf("usage:\n");
        printf("  shuggle chat \"your message\" [session \"name\"] [temperature 0.9] [search] [nothink] [new]\n");
        printf("  shuggle ask  \"your message\"                  (quick one-off ask)\n");
        printf("  shuggle cli                                  (interactive mode)\n");
        return 2;
    }
    std::string text, session_name;
    double temperature = -1;
    bool search = false, nothink = false, force_new = false;
    for (size_t i = 1; i < args.size(); i++) {
        const std::string& a = args[i];
        if (a == "session" || a == "s") {
            if (i + 1 < args.size()) session_name = args[++i];
        } else if (a == "temperature" || a == "temp") {
            if (i + 1 < args.size()) temperature = atof(args[++i].c_str());
        } else if (a == "search") {
            search = true;
        } else if (a == "nothink") {
            nothink = true;
        } else if (a == "new") {
            force_new = true;
        } else if (text.empty() && a.size() >= 2 && a.front() == '"' && a.back() == '"') {
            text = a.substr(1, a.size() - 2);
        } else if (text.empty()) {
            text = a;
        }
    }
    if (trim(text).empty()) {
        print_err("empty message");
        return 2;
    }

    Session s = pick_or_create_session(app, force_new ? "" : session_name);
    if (force_new) s.title = session_name.empty() ? "chat " + iso8601_utc(now_epoch_seconds()) : session_name;
    if (temperature >= 0) {
        ModelSettings m = s.settings.effective_model(app.settings.model);
        m.temperature = temperature;
        s.settings.model = m;
    }
    if (search) s.settings.search_enabled_v = true;
    if (nothink) {
        ModelSettings m = s.settings.effective_model(app.settings.model);
        m.thinking_enabled = false;
        s.settings.model = m;
    }

    std::mutex print_mu;
    EngineCallbacks cb;
    cb.on_stage = [](const std::string& stage) {
        fprintf(stderr, "\r\033[2m[%s]\033[0m", stage.c_str());
    };
    cb.on_thinking = [&](const std::string& piece) {
        std::lock_guard<std::mutex> lk(print_mu);
        fprintf(stderr, "%s", piece.c_str());  // thinking goes dim to stderr
    };
    cb.on_content = [&](const std::string& piece) {
        std::lock_guard<std::mutex> lk(print_mu);
        printf("%s", piece.c_str());
        fflush(stdout);
    };
    cb.keep_going = [] { return true; };
    app.engine->set_user_active(true);  // a user just typed — keep the notebook warm
    ChatReply r = app.engine->chat(s, text, {}, cb);
    app.engine->set_user_active(false);
    printf("\n");
    if (!r.error.empty()) print_err(r.error);
    else {
        int secs = r.elapsed_ms / 1000;
        fprintf(stderr, "\033[2m— %s, %dm%02ds%s\033[0m\n", s.title.c_str(), secs / 60, secs % 60,
                r.memory_note.empty() ? "" : (" · " + r.memory_note).c_str());
    }
    app.store->save_session(s);
    return r.error.empty() ? 0 : 1;
}

// ── interactive mode ──────────────────────────────────────────────────────────

static void print_help_interactive() {
    printf("commands:\n");
    printf("  new [name]              start a new chat\n");
    printf("  use <name|id>           switch to a chat\n");
    printf("  list                    list chats\n");
    printf("  del <name|id>           delete a chat (asks confirmation)\n");
    printf("  pin <name|id>           toggle pin\n");
    printf("  tokens                  show token pool + usage\n");
    printf("  addtoken                add a Kaggle token (paste KGAT_...)\n");
    printf("  memory                  show memory file\n");
    printf("  quit                    exit\n");
    printf("  anything else           chat message to the current session\n");
}

static void show_tokens(App& app) {
    auto meter = app.tokens->pool_meter();
    printf("token pool: %zu total | ready %d | in-use %d | exhausted %d | invalid %d\n",
           app.tokens->size(), meter.ready, meter.in_use, meter.exhausted, meter.invalid);
    printf("pooled usage: %.2fh used of %.2fh | next reset: %s\n", meter.used_hours,
           meter.total_hours, meter.next_reset_utc.empty() ? "?" : meter.next_reset_utc.c_str());
    int i = 0;
    for (const auto& t : app.tokens->all()) {
        printf("  [%d] %s…%s  @%s  %s  %.1fh/%.1fh  %s\n", i++, t.token.substr(0, 8).c_str(),
               t.token.substr(t.token.size() - 4).c_str(),
               t.username.empty() ? "?" : t.username.c_str(), token_state_name(t.state),
               t.quota.used_hours(), t.quota.total_hours(),
               t.last_error.empty() ? "" : t.last_error.c_str());
    }
}

static int cmd_interactive(App& app) {
    printf("%s", banner(stdout_is_tty()));
    print_help_interactive();
    Session cur = pick_or_create_session(app, "");
    printf("\n[%s] ready. type a message.\n\n", cur.title.c_str());
    std::string line;
    while (true) {
        printf("%s> ", cur.title.c_str());
        if (!std::getline(std::cin, line)) break;
        line = trim(line);
        if (line.empty()) continue;
        if (line == "quit" || line == "exit") break;
        if (line == "help") { print_help_interactive(); continue; }
        if (line == "list") {
            for (const auto& s : app.store->list_sessions(false)) {
                printf("  %s %-40s  %s%s\n", s.pinned ? "*" : " ", s.title.c_str(),
                       s.id.substr(0, 8).c_str(),
                       s.id == cur.id ? "  <- current" : "");
            }
            continue;
        }
        if (starts_with(line, "new ")) {
            cur = pick_or_create_session(app, trim(line.substr(4)));
            printf("started [%s]\n", cur.title.c_str());
            continue;
        }
        if (line == "new") {
            cur = pick_or_create_session(app, "");
            printf("started [%s]\n", cur.title.c_str());
            continue;
        }
        if (starts_with(line, "use ")) {
            std::string key = trim(line.substr(4));
            bool found = false;
            for (auto& s : app.store->list_sessions(true)) {
                if (s.title == key || starts_with(s.id, key)) {
                    cur = s;
                    printf("switched to [%s]\n", cur.title.c_str());
                    found = true;
                    break;
                }
            }
            if (!found) printf("no chat named '%s'\n", key.c_str());
            continue;
        }
        if (starts_with(line, "del ")) {
            std::string key = trim(line.substr(4));
            for (auto& s : app.store->list_sessions(false)) {
                if (s.title == key || starts_with(s.id, key)) {
                    if (s.id == cur.id) {
                        printf("cannot delete the current chat; switch first\n");
                        break;
                    }
                    printf("delete '%s'? (y/N) ", s.title.c_str());
                    std::string yn;
                    std::getline(std::cin, yn);
                    if (yn == "y" || yn == "Y") {
                        app.store->delete_session(s.id);
                        printf("deleted\n");
                    }
                    break;
                }
            }
            continue;
        }
        if (starts_with(line, "pin ")) {
            std::string key = trim(line.substr(4));
            for (auto& s : app.store->list_sessions(false)) {
                if (s.title == key || starts_with(s.id, key)) {
                    s.pinned = !s.pinned;
                    app.store->save_session(s);
                    printf("%s '%s'\n", s.pinned ? "pinned" : "unpinned", s.title.c_str());
                    break;
                }
            }
            continue;
        }
        if (line == "tokens") { show_tokens(app); continue; }
        if (line == "addtoken") {
            printf("paste token: ");
            std::string tok;
            std::getline(std::cin, tok);
            std::string err;
            if (app.tokens->add_token(trim(tok), "", err)) {
                app.tokens->save();
                print_ok("token added");
            } else {
                print_err(err);
            }
            continue;
        }
        if (line == "memory") {
            printf("%s", app.memory->render_markdown());
            continue;
        }
        if (line == "settings") {
            printf("cli owns no settings — edit %s directly (per HAKORA)\n",
                   settings_file_path().c_str());
            continue;
        }

        // plain chat
        EngineCallbacks cb;
        cb.on_stage = [](const std::string& stage) {
            fprintf(stderr, "\r\033[2m[%s]\033[0m", stage.c_str());
        };
        cb.on_thinking = [&](const std::string& piece) { fprintf(stderr, "%s", piece.c_str()); };
        cb.on_content = [&](const std::string& piece) {
            printf("%s", piece.c_str());
            fflush(stdout);
        };
        cb.keep_going = [] { return true; };
        printf("\n");
        ChatReply r = app.engine->chat(cur, line, {}, cb);
        printf("\n\n");
        if (!r.error.empty()) print_err(r.error);
        int secs = r.elapsed_ms / 1000;
        fprintf(stderr, "\033[2m— %dm%02ds%s\033[0m\n\n", secs / 60, secs % 60,
                r.memory_note.empty() ? "" : (" · " + r.memory_note).c_str());
    }
    printf("bye!\n");
    return 0;
}

// ── entry ─────────────────────────────────────────────────────────────────────

int main(int argc, char** argv) {
    App app;
    app.init();
    seed_token_from_env(app);

    std::vector<std::string> args(argv + 1, argv + argc);
    if (args.empty()) {
        printf("%s", banner(stdout_is_tty()));
        printf("no mode given. try: shuggle cli | shuggle chat \"...\"\n");
        return 0;
    }
    if (args[0] == "version" || args[0] == "--version" || args[0] == "-v") {
        printf("Shuggle v%s\n", kAppVersion);
        return 0;
    }
    if (args[0] == "tokens") { show_tokens(app); return 0; }
    if (args[0] == "cli") return cmd_interactive(app);
    if (args[0] == "chat" || args[0] == "ask") {
        if (stdout_is_tty()) fprintf(stderr, "%s", banner(true));
        return cmd_oneline(app, args);
    }
    printf("%s", banner(stdout_is_tty()));
    printf("unknown mode '%s'. try: shuggle cli | shuggle chat \"...\" | shuggle tokens\n",
           args[0].c_str());
    return 2;
}
