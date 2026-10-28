// Shuggle — Kaggle API client (pure official API, Bearer KGAT auth)
// Endpoints ported + live-verified from the v1 C++ client and the v2 probes.

import { USER_AGENT } from "../version.ts";

const BASE = "https://www.kaggle.com/api/v1";

export interface RpcResult {
  status: number;
  body: any;
  text: string;
}

export class KaggleError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

function slugifyTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export class Kaggle {
  constructor(public bearer: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.bearer}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      ...extra,
    };
  }

  async rpc(method: string, body: any, timeoutMs = 90_000): Promise<RpcResult> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${BASE}/${method}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      });
      const text = await r.text();
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
      return { status: r.status, body: parsed, text };
    } finally {
      clearTimeout(t);
    }
  }

  private async expectOk(method: string, body: any, what: string, timeoutMs = 90_000): Promise<any> {
    const r = await this.rpc(method, body, timeoutMs);
    if (r.status !== 200) {
      const msg = typeof r.body === "object" && r.body ? r.body?.error?.message || JSON.stringify(r.body).slice(0, 300) : String(r.text).slice(0, 300);
      throw new KaggleError(`${what}: HTTP ${r.status} ${msg}`, r.status);
    }
    return r.body;
  }

  // ---- account -----------------------------------------------------------

  async introspect(): Promise<{ username: string; userId?: number }> {
    const j = await this.expectOk("security.OAuthService/IntrospectToken", { token: this.bearer }, "introspect");
    if (!j?.active || !j?.username) throw new KaggleError("token is not active");
    return { username: j.username as string, userId: j.userId ?? j.user_id };
  }

  async quota(): Promise<{ usedHours: number; totalHours: number; resetAt: string }> {
    const j = await this.expectOk("kernels.KernelsApiService/GetAcceleratorQuotaStatistics", {}, "quota");
    const gpu = j?.gpuQuota ?? {};
    const secs = (s: any) => {
      if (typeof s !== "string") return 0;
      const m = s.match(/^([\d.]+)(s|m|h|d)?$/);
      if (!m) return 0;
      const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] ?? "s"] ?? 1;
      return parseFloat(m[1]) * mult;
    };
    return {
      usedHours: secs(gpu.timeUsed) / 3600,
      totalHours: secs(gpu.totalTimeAllowed) / 3600,
      resetAt: j.quotaRefreshTime ?? "",
    };
  }

  // ---- kernels -----------------------------------------------------------

  async pushKernel(opts: {
    owner: string;
    slug: string;
    title: string;
    script: string;
    run: boolean;
    gpu: boolean;
    internet: boolean;
    machineShape?: string;
    datasetSources?: string[];
    timeoutSeconds?: number;
  }): Promise<{ slug: string; version: number; url: string }> {
    const body: any = {
      slug: `${opts.owner}/${opts.slug}`,
      newTitle: opts.title.length >= 5 ? opts.title : opts.title + " ",
      text: opts.script,
      language: "python",
      kernelType: "script",
      isPrivate: true,
      enableGpu: opts.gpu,
      enableInternet: opts.internet,
      kernelExecutionType: opts.run ? "SAVE_AND_RUN_ALL" : "QUICK_SAVE",
    };
    if (opts.gpu && opts.machineShape !== undefined) body.machineShape = opts.machineShape;
    if (opts.datasetSources?.length) body.datasetDataSources = opts.datasetSources;
    if (opts.run) body.sessionTimeoutSeconds = opts.timeoutSeconds ?? 3600 * 6;
    const j = await this.expectOk("kernels.KernelsApiService/SaveKernel", body, "push kernel", 120_000);
    if (j?.error) throw new KaggleError(`push kernel: ${j.error}`);
    if (j?.message && !j?.ref) throw new KaggleError(`push kernel: ${j.message}`);
    // The API derives the real slug from the title — parse it from the response url/ref.
    let slug = opts.slug;
    const url: string = j?.url ?? "";
    const m = url.match(/\/code\/[^/]+\/([^/?#]+)/);
    if (m) slug = m[1];
    return { slug, version: j?.versionNumber ?? 0, url };
  }

  async kernelStatus(owner: string, slug: string): Promise<{ status: string; failureMessage?: string }> {
    // 403 with PERMISSION_DENIED means "no such kernel" in practice.
    const r = await this.rpc("kernels.KernelsApiService/GetKernelSessionStatus", { userName: owner, kernelSlug: slug });
    if (r.status === 403) return { status: "NEVER_RUN" };
    if (r.status !== 200) return { status: "UNKNOWN" };
    return {
      status: r.body?.status ?? "UNKNOWN",
      failureMessage: r.body?.failureMessage ?? undefined,
    };
  }

  async kernelLog(owner: string, slug: string): Promise<string> {
    let out = "";
    let token = "";
    for (let page = 0; page < 80; page++) {
      const j = await this.expectOk(
        "kernels.KernelsApiService/ListKernelSessionOutput",
        { userName: owner, kernelSlug: slug, pageSize: 300, pageToken: token },
        "kernel log",
        60_000,
      );
      out += j?.log ?? "";
      token = j?.nextPageToken ?? "";
      if (!token) break;
    }
    return out;
  }

  /** Live log stream (SSE). Returns an async iterable of text events. */
  async *logStream(owner: string, slug: string, signal?: AbortSignal): AsyncGenerator<string> {
    const url = `${BASE}/kernels/logs/stream/${owner}/${slug}`;
    const r = await fetch(url, { headers: this.headers(), signal });
    if (!r.ok || !r.body) return;
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim()) yield line;
        }
      }
    } catch {
      /* stream ended */
    }
  }

  async deleteKernel(owner: string, slug: string): Promise<void> {
    await this.expectOk("kernels.KernelsApiService/DeleteKernel", { userName: owner, kernelSlug: slug }, "delete kernel");
  }

  // ---- datasets ----------------------------------------------------------

  async datasetExists(owner: string, slug: string): Promise<boolean> {
    const r = await this.rpc("datasets.DatasetApiService/GetDatasetStatus", { ownerSlug: owner, datasetSlug: slug });
    if (r.status !== 200) return false;
    const s = typeof r.body === "object" ? r.body?.status ?? "" : String(r.text);
    return s !== "" && s !== "NOT_FOUND";
  }

  async listMyDatasets(): Promise<{ ref: string; title: string }[]> {
    const r = await fetch(`${BASE}/datasets/list?group=my&pageSize=100&sortBy=updated`, {
      headers: this.headers(),
    });
    if (!r.ok) return [];
    const arr = (await r.json()) as any[];
    return (arr ?? []).map((d) => ({
      ref: d.refNullable ?? d.ref ?? "",
      title: d.titleNullable ?? d.title ?? "",
    }));
  }

  private async blobUpload(name: string, content: Uint8Array): Promise<string> {
    const j = await this.expectOk(
      "blobs.BlobApiService/StartBlobUpload",
      {
        type: "DATASET",
        name,
        contentType: "application/octet-stream",
        contentLength: content.length,
        lastModifiedEpochSeconds: Math.floor(Date.now() / 1000),
      },
      "blob start",
    );
    const token: string = j.token;
    const createUrl: string = j.createUrl;
    const put = await fetch(createUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: content,
    });
    if (put.status !== 200 && put.status !== 201) {
      throw new KaggleError(`blob put: HTTP ${put.status}`);
    }
    return token;
  }

  async datasetUpsert(
    owner: string,
    slug: string,
    title: string,
    files: Record<string, string | Uint8Array>,
    versionNotes = "shuggle sync",
  ): Promise<void> {
    if (title.length < 5) throw new KaggleError("dataset title must be at least 5 characters");
    const tokens: any[] = [];
    for (const [name, content] of Object.entries(files)) {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      tokens.push({ token: await this.blobUpload(name, bytes), description: "", columns: [] });
    }
    const exists = await this.datasetExists(owner, slug);
    const fileBody = {
      files: tokens,
      subtitle: "shuggle data",
      description: "Shuggle storage. Managed automatically by the Shuggle app.",
      categoryIds: [],
      versionNotes,
    };
    if (exists) {
      const j = await this.expectOk(
        "datasets.DatasetApiService/CreateDatasetVersion",
        { ownerSlug: owner, datasetSlug: slug, body: fileBody },
        "dataset version",
        180_000,
      );
      if (j?.error) throw new KaggleError(`dataset version: ${j.error}`);
    } else {
      const j = await this.expectOk(
        "datasets.DatasetApiService/CreateDataset",
        { ownerSlug: owner, slug, title, licenseName: "CC0-1.0", isPrivate: true, ...fileBody },
        "dataset create",
        180_000,
      );
      if (j?.error) throw new KaggleError(`dataset create: ${j.error}`);
    }
  }

  async datasetDownloadText(owner: string, slug: string, fileName: string): Promise<string | null> {
    // POST returns 302 to a signed URL; fetch follows redirects transparently.
    try {
      const r = await fetch(`${BASE}/datasets.DatasetApiService/DownloadDataset`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ ownerSlug: owner, datasetSlug: slug, fileName, raw: true }),
        redirect: "follow",
      });
      if (r.status === 404) return null;
      if (!r.ok) return null;
      return await r.text();
    } catch {
      return null;
    }
  }

  async datasetDelete(owner: string, slug: string): Promise<void> {
    await this.expectOk("datasets.DatasetApiService/DeleteDataset", { ownerSlug: owner, datasetSlug: slug }, "dataset delete");
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
