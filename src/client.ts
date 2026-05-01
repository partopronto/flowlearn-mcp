import type { Config } from "./config.js";

export class FlowlearnApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    const bodyStr =
      typeof body === "string" ? body : JSON.stringify(body, null, 2);
    super(`Flowlearn API ${status} on ${path}: ${bodyStr}`);
    this.name = "FlowlearnApiError";
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** Override Content-Type. Defaults to application/json when body is set. */
  contentType?: string;
  /** Send body as raw Buffer/string instead of JSON-stringifying it. */
  rawBody?: BodyInit;
};

export class FlowlearnClient {
  private cookieJar: string | null = null;

  constructor(private readonly config: Config) {}

  /** Read-only snapshot of current config (email + active tenant + base URL). */
  getConfig(): Readonly<Config> {
    return this.config;
  }

  /** Mutate the active tenant slug for this process. Caller is responsible for
   *  validating that the user is a member of the new tenant. */
  setTenantSlug(slug: string): void {
    this.config.tenantSlug = slug;
  }

  /** Mutate the email for this process. Invalidates the cached session cookie
   *  so the next request triggers a fresh sign-in with the new email. */
  setEmail(email: string): void {
    this.config.email = email;
    this.cookieJar = null;
  }

  /** Mutate the password for this process. Invalidates the cached session
   *  cookie so the next request triggers a fresh sign-in. */
  setPassword(password: string): void {
    this.config.password = password;
    this.cookieJar = null;
  }

  /**
   * POST to Better Auth sign-in/email and cache Set-Cookie values.
   * Throws if credentials are rejected.
   */
  private async signIn(): Promise<void> {
    const url = `${this.config.baseUrl}/api/auth/sign-in/email`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: this.config.baseUrl,
      },
      body: JSON.stringify({
        email: this.config.email,
        password: this.config.password,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new FlowlearnApiError(res.status, "/api/auth/sign-in/email", text);
    }

    const cookies = extractSetCookies(res.headers);
    if (cookies.length === 0) {
      throw new Error(
        "Sign-in succeeded but no Set-Cookie header returned. " +
          "Verify FLOWLEARN_BASE_URL points at a Flowlearn instance with Better Auth enabled.",
      );
    }
    this.cookieJar = cookies.join("; ");
  }

  /**
   * Send a request with the cached session cookie + tenant header.
   * On 401, re-sign-in once and retry.
   */
  async request<T = unknown>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    if (!this.cookieJar) {
      await this.signIn();
    }

    const doFetch = async () => {
      const headers: Record<string, string> = {
        cookie: this.cookieJar!,
        "x-tenant-slug": this.config.tenantSlug,
        origin: this.config.baseUrl,
      };

      let body: BodyInit | undefined;
      if (options.rawBody !== undefined) {
        body = options.rawBody;
        if (options.contentType) headers["content-type"] = options.contentType;
      } else if (options.body !== undefined) {
        body = JSON.stringify(options.body);
        headers["content-type"] = options.contentType ?? "application/json";
      }

      return fetch(`${this.config.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body,
      });
    };

    let res = await doFetch();
    if (res.status === 401) {
      await this.signIn();
      res = await doFetch();
    }

    const responseText = await res.text();
    let parsed: unknown = responseText;
    if (responseText.length > 0) {
      try {
        parsed = JSON.parse(responseText);
      } catch {
        // keep as text
      }
    }

    if (!res.ok) {
      throw new FlowlearnApiError(res.status, path, parsed);
    }

    return parsed as T;
  }
}

/**
 * Extract Set-Cookie values from a Headers object.
 * Uses getSetCookie() (Node 20.0+) when available; falls back to raw iteration.
 */
function extractSetCookies(headers: Headers): string[] {
  const anyHeaders = headers as unknown as {
    getSetCookie?: () => string[];
  };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie().map((c) => c.split(";")[0]);
  }
  const single = headers.get("set-cookie");
  if (!single) return [];
  return single.split(/,(?=\s*[A-Za-z0-9_-]+=)/).map((c) => c.split(";")[0].trim());
}
