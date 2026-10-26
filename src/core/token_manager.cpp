// Shuggle — token_manager.cpp
#include "token_manager.h"

#include <nlohmann/json.hpp>

#include "util.h"

using nlohmann::json;

namespace shuggle {

const char* token_state_name(TokenState s) {
    switch (s) {
        case TokenState::NEW: return "new";
        case TokenState::READY: return "ready";
        case TokenState::IN_USE: return "in_use";
        case TokenState::EXHAUSTED: return "exhausted";
        case TokenState::INVALID: return "invalid";
        case TokenState::COOLDOWN: return "cooldown";
    }
    return "?";
}

static TokenState state_from_name(const std::string& n) {
    if (n == "ready") return TokenState::READY;
    if (n == "in_use") return TokenState::IN_USE;
    if (n == "exhausted") return TokenState::EXHAUSTED;
    if (n == "invalid") return TokenState::INVALID;
    if (n == "cooldown") return TokenState::COOLDOWN;
    return TokenState::NEW;
}

TokenManager::TokenManager(const std::string& file_path) : file_(file_path) {}

bool TokenManager::load() {
    std::lock_guard<std::mutex> lk(mu_);
    tokens_.clear();
    std::string data;
    if (!read_file(file_, data) || data.empty()) return true; // fresh start
    try {
        json j = json::parse(data);
        for (const auto& t : j.value("tokens", json::array())) {
            ManagedToken mt;
            mt.token = t.value("token", "");
            mt.label = t.value("label", "");
            mt.username = t.value("username", "");
            mt.user_id = t.value("user_id", (int64_t)0);
            mt.state = state_from_name(t.value("state", "new"));
            mt.added_at = t.value("added_at", (int64_t)0);
            mt.last_checked = t.value("last_checked", (int64_t)0);
            mt.last_error = t.value("last_error", "");
            if (t.contains("quota") && !t["quota"].is_null()) {
                const auto& q = t["quota"];
                mt.quota.time_used_s = q.value("time_used_s", 0.0);
                mt.quota.time_reserved_s = q.value("time_reserved_s", 0.0);
                mt.quota.total_allowed_s = q.value("total_allowed_s", 0.0);
                mt.quota.minimum_allowed_s = q.value("minimum_allowed_s", 0.0);
                mt.quota.has_ever_run = q.value("has_ever_run", false);
                mt.quota.refresh_time_utc = q.value("refresh_time_utc", "");
            }
            if (!mt.token.empty()) tokens_.push_back(std::move(mt));
        }
        return true;
    } catch (...) {
        return false;
    }
}

bool TokenManager::save() const {
    std::lock_guard<std::mutex> lk(mu_);
    json j;
    j["tokens"] = json::array();
    for (const auto& mt : tokens_) {
        json t = {{"token", mt.token},
                  {"label", mt.label},
                  {"username", mt.username},
                  {"user_id", mt.user_id},
                  {"state", token_state_name(mt.state)},
                  {"added_at", mt.added_at},
                  {"last_checked", mt.last_checked},
                  {"last_error", mt.last_error},
                  {"quota",
                   {{"time_used_s", mt.quota.time_used_s},
                    {"time_reserved_s", mt.quota.time_reserved_s},
                    {"total_allowed_s", mt.quota.total_allowed_s},
                    {"minimum_allowed_s", mt.quota.minimum_allowed_s},
                    {"has_ever_run", mt.quota.has_ever_run},
                    {"refresh_time_utc", mt.quota.refresh_time_utc}}}};
        j["tokens"].push_back(t);
    }
    return write_file(file_, j.dump(2));
}

bool TokenManager::add_token(const std::string& kgat, const std::string& label,
                             std::string& err) {
    std::string t = trim(kgat);
    if (t.empty()) { err = "token is empty"; return false; }
    if (!starts_with(t, "KGAT_")) {
        err = "that does not look like a Kaggle API token (expected KGAT_...)";
        return false;
    }
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (tokens_.size() >= kMaxTokens) {
            err = "token list is full (100)";
            return false;
        }
        for (const auto& mt : tokens_)
            if (mt.token == t) { err = "duplicate token (already in list)"; return false; }
    }
    // introspect (network, outside lock)
    KaggleClient client(t);
    TokenIdentity id;
    if (!client.introspect(id, err)) {
        err = "token rejected by Kaggle: " + err;
        return false;
    }
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (const auto& mt : tokens_)
            if (mt.user_id == id.user_id) {
                err = "same account already present as token of @" + mt.username +
                      " — one token per account";
                return false;
            }
    }
    QuotaInfo q;
    std::string qerr;
    client.quota(q, qerr);
    std::lock_guard<std::mutex> lk(mu_);
    ManagedToken mt;
    mt.token = t;
    mt.label = label;
    mt.username = id.username;
    mt.user_id = id.user_id;
    mt.quota = q;
    mt.state = q.exhausted() ? TokenState::EXHAUSTED : TokenState::READY;
    mt.added_at = now_epoch_seconds();
    mt.last_checked = now_epoch_seconds();
    tokens_.push_back(std::move(mt));
    return true;
}

bool TokenManager::remove_token(const std::string& kgat) {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto it = tokens_.begin(); it != tokens_.end(); ++it)
        if (it->token == kgat) { tokens_.erase(it); return true; }
    return false;
}

std::vector<ManagedToken> TokenManager::all() const {
    std::lock_guard<std::mutex> lk(mu_);
    return tokens_;
}

size_t TokenManager::size() const {
    std::lock_guard<std::mutex> lk(mu_);
    return tokens_.size();
}

bool TokenManager::has_token(const std::string& kgat) const {
    std::lock_guard<std::mutex> lk(mu_);
    for (const auto& mt : tokens_)
        if (mt.token == kgat) return true;
    return false;
}

const ManagedToken* TokenManager::auto_pick() const {
    std::lock_guard<std::mutex> lk(mu_);
    const ManagedToken* best = nullptr;
    for (const auto& mt : tokens_) {
        // READY and IN_USE are both usable — IN_USE just means this app already
        // booted an engine on it (quota still applies)
        if (mt.state != TokenState::READY && mt.state != TokenState::IN_USE) continue;
        if (!best) { best = &mt; continue; }
        double my_left = mt.quota.remaining_hours();
        double best_left = best->quota.remaining_hours();
        if (my_left > best_left ||
            (my_left == best_left && mt.last_checked < best->last_checked))
            best = &mt;
    }
    return best;  // points into tokens_ — caller must not free; safe under snapshot use
}

void TokenManager::mark_in_use(const std::string& kgat, bool in_use) {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& mt : tokens_) {
        if (mt.token != kgat) continue;
        if (in_use) mt.state = TokenState::IN_USE;
        else mt.state = mt.quota.exhausted() ? TokenState::EXHAUSTED : TokenState::READY;
    }
}

void TokenManager::mark_cooldown(const std::string& kgat, int seconds, const std::string& why) {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& mt : tokens_) {
        if (mt.token != kgat) continue;
        mt.state = TokenState::COOLDOWN;
        mt.cooldown_until = now_epoch_seconds() + seconds;
        mt.last_error = why;
    }
}

void TokenManager::mark_invalid(const std::string& kgat, const std::string& why) {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& mt : tokens_) {
        if (mt.token != kgat) continue;
        mt.state = TokenState::INVALID;
        mt.last_error = why;
    }
}

bool TokenManager::refresh_one() {
    std::string target;
    {
        std::lock_guard<std::mutex> lk(mu_);
        // pick least-recently-checked non-invalid token
        int64_t oldest = INT64_MAX;
        for (const auto& mt : tokens_) {
            if (mt.state == TokenState::INVALID) continue;
            if (mt.last_checked < oldest) { oldest = mt.last_checked; target = mt.token; }
        }
    }
    if (target.empty()) return false;
    KaggleClient client(target);
    QuotaInfo q;
    std::string err;
    bool ok = client.quota(q, err);
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& mt : tokens_) {
        if (mt.token != target) continue;
        mt.last_checked = now_epoch_seconds();
        if (ok) {
            mt.quota = q;
            if (mt.state == TokenState::IN_USE) {
                // leave as is
            } else if (q.exhausted()) {
                mt.state = TokenState::EXHAUSTED;
            } else if (mt.state == TokenState::EXHAUSTED || mt.state == TokenState::COOLDOWN ||
                       mt.state == TokenState::READY) {
                mt.state = TokenState::READY;
            }
            mt.last_error.clear();
        } else if (mt.state != TokenState::IN_USE) {
            mt.last_error = err;
            if (mt.state == TokenState::NEW) mt.state = TokenState::COOLDOWN;
        }
        return ok;
    }
    return false;
}

bool TokenManager::introspect_one() {
    std::string target;
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (const auto& mt : tokens_)
            if (mt.state == TokenState::NEW || mt.username.empty()) { target = mt.token; break; }
    }
    if (target.empty()) return false;
    KaggleClient client(target);
    TokenIdentity id;
    std::string err;
    bool ok = client.introspect(id, err);
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& mt : tokens_) {
        if (mt.token != target) continue;
        if (ok) {
            mt.username = id.username;
            mt.user_id = id.user_id;
        } else {
            mt.last_error = err;
        }
        return ok;
    }
    return false;
}

int TokenManager::recover_expired() {
    int recovered = 0;
    int64_t now = now_epoch_seconds();
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& mt : tokens_) {
        if (mt.state != TokenState::EXHAUSTED) continue;
        auto reset = parse_iso8601(mt.quota.refresh_time_utc);
        if (reset && now >= *reset) {
            mt.state = mt.quota.exhausted() ? TokenState::EXHAUSTED : TokenState::READY;
            if (mt.state == TokenState::READY) recovered++;
        }
        // also clear expired cooldowns
        if (mt.state == TokenState::COOLDOWN && now >= mt.cooldown_until)
            mt.state = mt.quota.exhausted() ? TokenState::EXHAUSTED : TokenState::READY;
    }
    return recovered;
}

TokenManager::PoolMeter TokenManager::pool_meter() const {
    std::lock_guard<std::mutex> lk(mu_);
    PoolMeter m;
    for (const auto& mt : tokens_) {
        m.used_hours += mt.quota.time_used_s / 3600.0;
        m.total_hours += mt.quota.total_allowed_s / 3600.0;
        switch (mt.state) {
            case TokenState::READY: m.ready++; break;
            case TokenState::IN_USE: m.in_use++; m.ready++; break; // usable
            case TokenState::EXHAUSTED: m.exhausted++; break;
            case TokenState::INVALID: m.invalid++; break;
            default: m.pending++; break;
        }
        if (mt.state == TokenState::EXHAUSTED &&
            (m.next_reset_utc.empty() || mt.quota.refresh_time_utc < m.next_reset_utc))
            m.next_reset_utc = mt.quota.refresh_time_utc;
    }
    return m;
}

} // namespace shuggle
