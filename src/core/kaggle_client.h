// Shuggle — kaggle_client.h
// C++ reimplementation of the Kaggle REST API surface Shuggle needs.
// Wire format verified against kaggle 2.2.5 / kagglesdk 0.1.38 source and live API.
// All calls: POST https://api.kaggle.com/v1/{Service}.{Service}/{Method}, Bearer KGAT auth.
#pragma once
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "../core/http.h"

namespace shuggle {

struct TokenIdentity {
    bool active = false;
    std::string username;
    int64_t user_id = 0;
};

struct QuotaInfo {
    double time_used_s = 0;
    double time_reserved_s = 0;
    double total_allowed_s = 0;
    double minimum_allowed_s = 0;
    bool has_ever_run = false;
    std::string refresh_time_utc;        // ISO8601
    bool exhausted() const {
        return total_allowed_s > 0 && (time_used_s + time_reserved_s) >= total_allowed_s;
    }
    double remaining_hours() const {
        double r = total_allowed_s - time_used_s - time_reserved_s;
        return r < 0 ? 0 : r / 3600.0;
    }
    double used_hours() const { return time_used_s / 3600.0; }
    double total_hours() const { return total_allowed_s / 3600.0; }
};

struct KernelPushResult {
    bool ok = false;
    std::string ref;        // "owner/slug"
    std::string url;
    int version = 0;
    std::string error;
};

struct KernelStatus {
    std::string status;     // QUEUED/RUNNING/COMPLETE/ERROR/CANCEL_*/NEW_SCRIPT
    std::string failure_message;
};

struct DatasetUploadResult {
    bool ok = false;
    std::string ref;
    std::string error;
};

class KaggleClient {
public:
    explicit KaggleClient(const std::string& bearer_token);

    // -- identity & quota ----------------------------------------------------
    // POST /v1/security.OAuthService/IntrospectToken  (works with KGAT tokens)
    bool introspect(TokenIdentity& out, std::string& err);
    // POST /v1/kernels.KernelsApiService/GetAcceleratorQuotaStatistics
    bool quota(QuotaInfo& out, std::string& err);

    // -- kernels ---------------------------------------------------------------
    // Push (create/update) a script-type kernel and run it on T4 x2.
    // machine_shape defaults to "NvidiaTeslaT4" (= GPU T4 x2).
    KernelPushResult save_kernel(const std::string& owner, const std::string& slug,
                                 const std::string& title, const std::string& script_source,
                                 bool run_now,           // false => QUICK_SAVE
                                 bool enable_internet = true,
                                 const std::vector<std::string>& dataset_sources = {},
                                 const std::string& machine_shape = "NvidiaTeslaT4");
    KernelStatus kernel_status(const std::string& owner, const std::string& slug,
                               std::string& err);
    // Full execution log of the latest session (paginated fetch assembled).
    bool kernel_log(const std::string& owner, const std::string& slug, std::string& log_out,
                    std::string& err);
    bool delete_kernel(const std::string& owner, const std::string& slug, std::string& err);

    // -- datasets --------------------------------------------------------------
    // Upload a set of files as a new private dataset (or new version if it exists).
    // Files are {name, content} in memory (Shuggle files are small JSON/MD).
    DatasetUploadResult dataset_upsert(const std::string& owner, const std::string& slug,
                                       const std::string& title,
                                       const std::vector<std::pair<std::string, std::string>>& files,
                                       const std::string& version_notes, std::string& err);
    // Download one text file from a dataset (zip-bypassing raw path where possible).
    bool dataset_file_text(const std::string& owner, const std::string& slug,
                           const std::string& file_name, std::string& out, std::string& err);
    bool dataset_exists(const std::string& owner, const std::string& slug);
    bool dataset_delete(const std::string& owner, const std::string& slug, std::string& err);

    const std::string& token() const { return token_; }

private:
    HttpResponse rpc(const std::string& service_method, const std::string& json_body,
                     long timeout = 45);
    bool blob_upload(const std::string& file_name, const std::string& content,
                     std::string& token_out, std::string& err);

    std::string token_;
    std::string base_ = "https://api.kaggle.com";
};

} // namespace shuggle
