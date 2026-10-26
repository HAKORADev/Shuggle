// Shuggle — token_manager.h
// The 100-token pool: introspection, same-account dedupe, exhaustion flags,
// weekly auto-recovery, background quota refresh, smart auto-assignment.
#pragma once
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

#include "kaggle_client.h"

namespace shuggle {

enum class TokenState {
    NEW,          // added, not yet introspected
    READY,        // has quota left
    IN_USE,       // currently bound to a live session
    EXHAUSTED,    // 30h wall hit; recovers at quota refresh time
    INVALID,      // dead/revoked token
    COOLDOWN,     // transient failure; short backoff
};

const char* token_state_name(TokenState s);

struct ManagedToken {
    std::string token;         // KGAT_...
    std::string label;         // optional user label
    std::string username;      // from introspect
    int64_t user_id = 0;
    TokenState state = TokenState::NEW;
    QuotaInfo quota;
    int64_t added_at = 0;
    int64_t last_checked = 0;
    int64_t cooldown_until = 0;
    std::string last_error;
};

class TokenManager {
public:
    static constexpr size_t kMaxTokens = 100;

    explicit TokenManager(const std::string& file_path);

    // Load/save tokens.json (does NOT hit network).
    bool load();
    bool save() const;

    // Add a token: introspects, enforces dedupe + one-per-account.
    // Returns false with reason on rejection.
    bool add_token(const std::string& kgat, const std::string& label, std::string& err);

    bool remove_token(const std::string& kgat);
    std::vector<ManagedToken> all() const;                 // thread-safe snapshot
    size_t size() const;
    bool has_token(const std::string& kgat) const;

    // Pick the best READY token: most remaining hours, tie -> least recently used.
    // Excludes optionally-bound tokens. Returns nullptr if none.
    const ManagedToken* auto_pick() const;

    // Markers used by sessions/engine.
    void mark_in_use(const std::string& kgat, bool in_use);
    void mark_cooldown(const std::string& kgat, int seconds, const std::string& why);
    void mark_invalid(const std::string& kgat, const std::string& why);

    // Refresh ONE pending token's quota via API (call from UI/background thread;
    // rotates through the pool). Returns false if nothing pending.
    bool refresh_one();
    // Introspect NEW tokens lazily (account identity).
    bool introspect_one();
    // Re-check EXHAUSTED tokens whose refresh_time has passed -> back to READY.
    int recover_expired();

    // Aggregate meter across all tokens (for the usage UI).
    struct PoolMeter {
        double used_hours = 0;
        double total_hours = 0;
        int ready = 0, exhausted = 0, invalid = 0, in_use = 0, pending = 0;
        std::string next_reset_utc;
    };
    PoolMeter pool_meter() const;

private:
    mutable std::mutex mu_;
    std::string file_;
    std::vector<ManagedToken> tokens_;
};

} // namespace shuggle
