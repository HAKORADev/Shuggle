// Shuggle — kaggle_client.cpp
#include "kaggle_client.h"

#include <nlohmann/json.hpp>

#include "util.h"

using nlohmann::json;

namespace shuggle {

KaggleClient::KaggleClient(const std::string& bearer_token) : token_(bearer_token) {}

HttpResponse KaggleClient::rpc(const std::string& service_method, const std::string& body,
                               long timeout) {
    HttpOptions opts;
    opts.headers.push_back("Authorization: Bearer " + token_);
    opts.timeout_seconds = timeout;
    return Http::post_json(base_ + "/v1/" + service_method, body, opts);
}

bool KaggleClient::introspect(TokenIdentity& out, std::string& err) {
    HttpResponse r = rpc("security.OAuthService/IntrospectToken",
                          json{{"token", token_}}.dump());
    if (!r.ok()) {
        err = "introspect failed: HTTP " + std::to_string(r.status) +
              (r.error.empty() ? "" : " " + r.error);
        return false;
    }
    try {
        json j = json::parse(r.body);
        out.active = j.value("active", false);
        out.username = j.value("username", "");
        if (j.contains("userId"))
            out.user_id = j["userId"].get<int64_t>();
        else if (j.contains("user_id"))
            out.user_id = j["user_id"].get<int64_t>();
        return out.active && !out.username.empty();
    } catch (const std::exception& e) {
        err = std::string("introspect parse: ") + e.what();
        return false;
    }
}

bool KaggleClient::quota(QuotaInfo& out, std::string& err) {
    HttpResponse r = rpc("kernels.KernelsApiService/GetAcceleratorQuotaStatistics", "{}");
    if (!r.ok()) {
        err = "quota failed: HTTP " + std::to_string(r.status) +
              (r.error.empty() ? "" : " " + r.error);
        return false;
    }
    try {
        json j = json::parse(r.body);
        out.refresh_time_utc = j.value("quotaRefreshTime", "");
        auto gpu = j.contains("gpuQuota") && !j["gpuQuota"].is_null() ? j["gpuQuota"] : json();
        if (!gpu.is_null()) {
            out.time_used_s = parse_timedelta(gpu.value("timeUsed", "0s"));
            out.time_reserved_s = parse_timedelta(gpu.value("timeReserved", "0s"));
            out.total_allowed_s = parse_timedelta(gpu.value("totalTimeAllowed", "0s"));
            out.minimum_allowed_s = parse_timedelta(gpu.value("minimumTimeAllowed", "0s"));
            out.has_ever_run = gpu.value("hasEverRun", false);
        }
        return true;
    } catch (const std::exception& e) {
        err = std::string("quota parse: ") + e.what();
        return false;
    }
}

KernelPushResult KaggleClient::save_kernel(const std::string& owner, const std::string& slug,
                                           const std::string& title,
                                           const std::string& script_source, bool run_now,
                                           bool enable_internet,
                                           const std::vector<std::string>& dataset_sources,
                                           const std::string& machine_shape) {
    KernelPushResult out;
    json req;
    req["slug"] = owner + "/" + slug;
    req["newTitle"] = title.size() >= 5 ? title : "Shuggle Engine";
    req["text"] = script_source;
    req["language"] = "python";
    req["kernelType"] = "script";
    req["isPrivate"] = true;
    req["enableGpu"] = true;
    req["enableInternet"] = enable_internet;
    req["machineShape"] = machine_shape;
    req["kernelExecutionType"] = run_now ? "SAVE_AND_RUN_ALL" : "QUICK_SAVE";
    if (run_now) req["sessionTimeoutSeconds"] = 21600;  // 6h backstop; watchdog stops earlier
    if (!dataset_sources.empty()) req["datasetDataSources"] = dataset_sources;

    HttpResponse r = rpc("kernels.KernelsApiService/SaveKernel", req.dump(), 90);
    if (!r.ok()) {
        out.error = "HTTP " + std::to_string(r.status) + " " +
                    (r.error.empty() ? r.body.substr(0, 300) : r.error);
        return out;
    }
    try {
        json j = json::parse(r.body);
        out.ref = j.value("ref", "");
        out.url = j.value("url", "");
        out.version = j.value("versionNumber", 0);
        out.error = j.value("error", "");
        out.ok = out.error.empty();
        // Some error shapes come as {"message": "..."} with 200
        if (out.ok && j.contains("message") && !j["message"].is_null())
            out.error = j["message"].get<std::string>();
        return out;
    } catch (const std::exception& e) {
        out.error = std::string("parse: ") + e.what();
        return out;
    }
}

KernelStatus KaggleClient::kernel_status(const std::string& owner, const std::string& slug,
                                         std::string& err) {
    KernelStatus st;
    json req = {{"userName", owner}, {"kernelSlug", slug}};
    HttpResponse r = rpc("kernels.KernelsApiService/GetKernelSessionStatus", req.dump());
    if (!r.ok()) {
        err = "HTTP " + std::to_string(r.status);
        // A kernel that never ran may 4xx here — surface as NEW_SCRIPT-ish
        st.status = "UNKNOWN";
        return st;
    }
    try {
        json j = json::parse(r.body);
        st.status = j.value("status", "UNKNOWN");
        if (j.contains("failureMessage") && !j["failureMessage"].is_null())
            st.failure_message = j["failureMessage"].get<std::string>();
        return st;
    } catch (const std::exception& e) {
        err = e.what();
        st.status = "UNKNOWN";
        return st;
    }
}

bool KaggleClient::kernel_log(const std::string& owner, const std::string& slug,
                              std::string& log_out, std::string& err) {
    log_out.clear();
    std::string page_token;
    for (int page = 0; page < 50; page++) {
        json req = {{"userName", owner},
                    {"kernelSlug", slug},
                    {"pageSize", 100},
                    {"pageToken", page_token}};
        HttpResponse r = rpc("kernels.KernelsApiService/ListKernelSessionOutput", req.dump(), 60);
        if (!r.ok()) {
            err = "HTTP " + std::to_string(r.status);
            return false;
        }
        try {
            json j = json::parse(r.body);
            if (j.contains("log") && !j["log"].is_null()) log_out += j["log"].get<std::string>();
            page_token = j.value("nextPageToken", "");
            if (page_token.empty()) return true;
        } catch (const std::exception& e) {
            err = e.what();
            return false;
        }
    }
    return true;
}

bool KaggleClient::delete_kernel(const std::string& owner, const std::string& slug,
                                 std::string& err) {
    json req = {{"userName", owner}, {"kernelSlug", slug}};
    HttpResponse r = rpc("kernels.KernelsApiService/DeleteKernel", req.dump());
    if (!r.ok()) { err = "HTTP " + std::to_string(r.status); return false; }
    return true;
}

bool KaggleClient::blob_upload(const std::string& file_name, const std::string& content,
                               std::string& token_out, std::string& err) {
    json req = {{"type", "DATASET"},
                {"name", file_name},
                {"contentType", "application/octet-stream"},
                {"contentLength", content.size()},
                {"lastModifiedEpochSeconds", now_epoch_seconds()}};
    HttpResponse r = rpc("blobs.BlobApiService/StartBlobUpload", req.dump());
    if (!r.ok()) {
        err = "StartBlobUpload HTTP " + std::to_string(r.status);
        return false;
    }
    try {
        json j = json::parse(r.body);
        token_out = j.value("token", "");
        std::string create_url = j.value("createUrl", "");
        if (token_out.empty() || create_url.empty()) {
            err = "blob upload: missing token/createUrl";
            return false;
        }
        // PUT bytes to createUrl (Google-resumable single shot). No Kaggle auth here.
        HttpOptions opts;
        opts.headers.push_back("Content-Type: application/octet-stream");
        opts.timeout_seconds = 120;
        HttpResponse pr = Http::put(create_url, content, opts);
        if (pr.status != 200 && pr.status != 201) {
            err = "blob PUT status " + std::to_string(pr.status) + " " + pr.body.substr(0, 200);
            return false;
        }
        return true;
    } catch (const std::exception& e) {
        err = std::string("blob upload: ") + e.what();
        return false;
    }
}

DatasetUploadResult KaggleClient::dataset_upsert(
    const std::string& owner, const std::string& slug, const std::string& title,
    const std::vector<std::pair<std::string, std::string>>& files,
    const std::string& version_notes, std::string& err) {
    DatasetUploadResult out;
    if (title.size() < 6) {
        err = "dataset title must be >= 6 chars";
        return out;
    }
    // upload all blobs first
    json file_tokens = json::array();
    for (const auto& [name, content] : files) {
        std::string tok;
        if (!blob_upload(name, content, tok, err)) return out;
        file_tokens.push_back(json{{"token", tok}, {"description", ""}, {"columns", json::array()}});
    }
    bool exists = dataset_exists(owner, slug);
    json body;
    body["files"] = file_tokens;
    body["subtitle"] = "shuggle sync data";
    body["description"] = "Shuggle sync dataset (chats, memory). Managed automatically.";
    body["categoryIds"] = json::array();
    json req;
    if (exists) {
        req = {{"ownerSlug", owner}, {"datasetSlug", slug}, {"body", body}};
        body["versionNotes"] = version_notes.empty() ? "shuggle sync" : version_notes;
        HttpResponse r =
            rpc("datasets.DatasetApiService/CreateDatasetVersion", req.dump(), 120);
        if (!r.ok()) {
            err = "CreateDatasetVersion HTTP " + std::to_string(r.status) + " " +
                  r.body.substr(0, 200);
            return out;
        }
        try {
            json j = json::parse(r.body);
            out.ok = j.value("status", "") == "ok" || j.value("status", "") == "OK";
            out.ref = j.value("ref", owner + "/" + slug);
            out.error = j.value("error", "");
        } catch (const std::exception& e) {
            err = e.what();
        }
        return out;
    }
    req = {{"ownerSlug", owner},
           {"slug", slug},
           {"title", title},
           {"licenseName", "CC0-1.0"},
           {"isPrivate", true},
           {"files", file_tokens},
           {"subtitle", "shuggle sync data"},
           {"description", "Shuggle sync dataset (chats, memory). Managed automatically."},
           {"categoryIds", json::array()}};
    HttpResponse r = rpc("datasets.DatasetApiService/CreateDataset", req.dump(), 120);
    if (!r.ok()) {
        err = "CreateDataset HTTP " + std::to_string(r.status) + " " + r.body.substr(0, 200);
        return out;
    }
    try {
        json j = json::parse(r.body);
        out.ok = j.value("status", "") == "ok" || j.value("status", "") == "OK";
        out.ref = j.value("ref", owner + "/" + slug);
        out.error = j.value("error", "");
    } catch (const std::exception& e) {
        err = e.what();
    }
    return out;
}

bool KaggleClient::dataset_exists(const std::string& owner, const std::string& slug) {
    json req = {{"ownerSlug", owner}, {"datasetSlug", slug}};
    HttpResponse r = rpc("datasets.DatasetApiService/GetDatasetStatus", req.dump());
    if (!r.ok()) return false;
    try {
        json j = json::parse(r.body);
        std::string st = j.value("status", "");
        return !st.empty() && st != "NOT_FOUND";
    } catch (...) {
        return false;
    }
}

bool KaggleClient::dataset_file_text(const std::string& owner, const std::string& slug,
                                     const std::string& file_name, std::string& out,
                                     std::string& err) {
    json req = {{"ownerSlug", owner},
                {"datasetSlug", slug},
                {"fileName", file_name},
                {"raw", true}};
    HttpOptions opts;
    opts.headers.push_back("Authorization: Bearer " + token_);
    opts.timeout_seconds = 90;
    HttpResponse r = Http::post_json(base_ + "/v1/datasets.DatasetApiService/DownloadDataset",
                                     req.dump(), opts);
    // The RPC responds with a redirect to a signed URL; curl follows it (follow=true).
    if (!r.ok()) {
        err = "download HTTP " + std::to_string(r.status);
        return false;
    }
    out = std::move(r.body);
    return true;
}

bool KaggleClient::dataset_delete(const std::string& owner, const std::string& slug,
                                  std::string& err) {
    json req = {{"ownerSlug", owner}, {"datasetSlug", slug}};
    HttpResponse r = rpc("datasets.DatasetApiService/DeleteDataset", req.dump());
    if (!r.ok()) { err = "HTTP " + std::to_string(r.status); return false; }
    return true;
}

} // namespace shuggle
