import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

export interface SafeUrlValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  origin?: string;
  hostname?: string;
  error?: string;
}

export interface ResolvedHostAddress {
  address: string;
  family: 4 | 6;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  '169.254.169.254',
  '0.0.0.0',
  '::1',
  '::',
  '[::1]',
  '[::]',
]);

const SENSITIVE_QUERY_PARAM_PATTERN =
  /^(token|access_token|api_key|apikey|key|secret|password|auth|signature|sig)$/i;

const MAX_OUTBOUND_RESPONSE_BYTES = 65_536;

export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');

  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b, c] = parts;

    // 0.0.0.0/8 (current network)
    if (a === 0) return true;
    // 10.0.0.0/8 (RFC1918 private)
    if (a === 10) return true;
    // 100.64.0.0/10 (Carrier-grade NAT / shared internal)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (Link-local & Cloud Metadata 169.254.169.254)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12 (RFC1918 private)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.0.0.0/24, 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 0) return true;
    // 192.88.99.0/24 (6to4 relay anycast)
    if (a === 192 && b === 88 && c === 99) return true;
    // 192.168.0.0/16 (RFC1918 private)
    if (a === 192 && b === 168) return true;
    // 198.18.0.0/15 (Benchmarking)
    if (a === 198 && (b === 18 || b === 19)) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (a === 198 && b === 51 && c === 100) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (a === 203 && b === 0 && c === 113) return true;
    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved/Broadcast)
    if (a >= 224) return true;

    return false;
  }

  if (net.isIPv6(normalized)) {
    if (normalized === '::' || normalized === '::1') return true;
    // IPv4-mapped IPv6 (e.g., ::ffff:127.0.0.1 or ::ffff:7f00:1)
    if (normalized.startsWith('::ffff:')) {
      const tail = normalized.slice('::ffff:'.length);
      if (net.isIPv4(tail)) {
        return isPrivateOrReservedIp(tail);
      }
      return true;
    }
    // NAT64 prefix (64:ff9b::/96)
    if (normalized.startsWith('64:ff9b:')) return true;
    // 6to4 tunneling (2002::/16)
    if (normalized.startsWith('2002:')) return true;
    // Documentation (2001:db8::/32) & Teredo (2001:0000::/32)
    if (
      normalized.startsWith('2001:db8:') ||
      normalized.startsWith('2001:0:') ||
      normalized.startsWith('2001:0000:') ||
      normalized.startsWith('2001::')
    ) {
      return true;
    }
    // Unique local (fc00::/7 -> fc.. or fd..)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    // Link-local (fe80::/10)
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return true;
    }
    return false;
  }

  return true;
}

/**
 * Pure synchronous check of URL syntax, protocol, embedded credentials, query secrets,
 * trailing-dot FQDN tricks, and literal IP / internal hostnames (unit-testable without network).
 */
export function validateDestinationUrlSync(
  rawUrl: string
): SafeUrlValidationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, error: 'Destination URL is required.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Destination URL is not a valid URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      error:
        'SSRF & transport policy: External webhook destinations must use HTTPS (https://).',
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error:
        'Embedded URL credentials (user:pass@host) are forbidden. Store credentials in the encrypted secret field instead.',
    };
  }

  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_QUERY_PARAM_PATTERN.test(key)) {
      return {
        valid: false,
        error: `Query parameter "${key}" appears to contain a secret. Pass secrets via encrypted authentication headers instead of the URL.`,
      };
    }
  }

  // Strip IPv6 brackets AND trailing root-zone dots (e.g. metadata.google.internal.)
  const rawHostNoBrackets = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const hostname = rawHostNoBrackets.replace(/\.+$/, '');

  if (
    !hostname ||
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.nip.io') ||
    hostname.endsWith('.sslip.io')
  ) {
    return {
      valid: false,
      error: `SSRF guard blocked internal or reserved hostname "${parsed.hostname}".`,
    };
  }

  if (net.isIP(hostname) !== 0 && isPrivateOrReservedIp(hostname)) {
    return {
      valid: false,
      error: `SSRF guard blocked private, loopback, or metadata IP address "${hostname}".`,
    };
  }

  // Canonicalize hostname if trailing dot was supplied
  if (rawHostNoBrackets !== hostname && net.isIP(hostname) === 0) {
    parsed.hostname = hostname;
  }

  return {
    valid: true,
    normalizedUrl: parsed.toString(),
    origin: parsed.origin,
    hostname,
  };
}

export type DnsLookupFn = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

const defaultDnsLookup: DnsLookupFn = (hostname: string) =>
  dns.lookup(hostname, { all: true });

/**
 * Full server-side outbound guard: validates URL syntax & scheme AND resolves DNS records,
 * returning the pinned public IP address(es) so the outbound socket never performs a second
 * unvalidated DNS lookup (eliminating DNS-rebinding TOCTOU).
 */
export async function assertSafeOutboundDestination(
  rawUrl: string,
  dnsLookup: DnsLookupFn = defaultDnsLookup
): Promise<{
  normalizedUrl: string;
  origin: string;
  hostname: string;
  resolvedAddresses: ResolvedHostAddress[];
}> {
  const syncCheck = validateDestinationUrlSync(rawUrl);
  if (!syncCheck.valid || !syncCheck.normalizedUrl || !syncCheck.hostname) {
    throw new Error(syncCheck.error || 'Unsafe destination URL rejected.');
  }

  const { hostname, normalizedUrl, origin } = syncCheck;
  const ipFamily = net.isIP(hostname);

  if (ipFamily === 4 || ipFamily === 6) {
    return {
      normalizedUrl,
      origin: origin!,
      hostname,
      resolvedAddresses: [{ address: hostname, family: ipFamily }],
    };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dnsLookup(hostname);
  } catch {
    throw new Error(
      `Unable to resolve external destination hostname "${hostname}".`
    );
  }

  if (!records || records.length === 0) {
    throw new Error(
      `Destination hostname "${hostname}" did not resolve to any IP address.`
    );
  }

  const validated: ResolvedHostAddress[] = [];
  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new Error(
        `SSRF guard blocked "${hostname}" because it resolves to a private or reserved IP address.`
      );
    }
    const fam = rec.family === 6 || net.isIPv6(rec.address) ? 6 : 4;
    validated.push({ address: rec.address, family: fam });
  }

  return {
    normalizedUrl,
    origin: origin!,
    hostname,
    resolvedAddresses: validated,
  };
}

export type SafeHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface SafeOutboundHttpRequestParams {
  url: string;
  method?: SafeHttpMethod;
  queryParams?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Record<string, unknown> | string | null;
  timeoutMs?: number;
  dnsLookup?: DnsLookupFn;
  allowQueryParams?: boolean;
}

export interface SafeOutboundHttpResponse {
  ok: boolean;
  status: number;
  responseText: string;
  destinationOrigin: string;
  headers: Record<string, string>;
}

/**
 * Executes an outbound HTTPS request (GET, POST, PUT, PATCH, DELETE) pinned to the exact
 * SSRF-validated IP address (eliminating DNS-rebinding TOCTOU), with TLS SNI preserved,
 * HTTP 3xx redirects blocked, and streaming response size capped at 64 KB.
 */
export async function safeOutboundHttpRequest(
  params: SafeOutboundHttpRequestParams
): Promise<SafeOutboundHttpResponse> {
  const { normalizedUrl, origin, hostname, resolvedAddresses } =
    await assertSafeOutboundDestination(params.url, params.dnsLookup);

  const parsedUrl = new URL(normalizedUrl);
  if (params.queryParams) {
    for (const [key, val] of Object.entries(params.queryParams)) {
      const trimmedKey = key.trim();
      if (!trimmedKey) continue;
      if (!params.allowQueryParams && SENSITIVE_QUERY_PARAM_PATTERN.test(trimmedKey)) {
        throw new Error(
          `Query parameter "${trimmedKey}" appears to contain a secret. Pass secrets via encrypted authentication headers instead of the URL.`
        );
      }
      parsedUrl.searchParams.set(trimmedKey, String(val));
    }
  }

  const method: SafeHttpMethod = params.method ?? 'POST';
  const pinnedTarget = resolvedAddresses[0];
  const hasBody =
    method !== 'GET' &&
    params.body !== undefined &&
    params.body !== null;

  const payloadString = hasBody
    ? typeof params.body === 'string'
      ? params.body
      : JSON.stringify(params.body)
    : null;

  const timeoutMs = Math.max(250, Math.min(params.timeoutMs ?? 10_000, 30_000));

  const requestHeaders: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    ...(params.headers ?? {}),
    'User-Agent': 'TaskAI-ExecutionRouter/2.2',
  };

  if (payloadString !== null) {
    if (!requestHeaders['Content-Type'] && !requestHeaders['content-type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }
    requestHeaders['Content-Length'] = String(
      Buffer.byteLength(payloadString, 'utf8')
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finishError = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      reject(err);
    };

    const req = https.request(
      {
        protocol: 'https:',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port ? Number(parsedUrl.port) : 443,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method,
        servername: hostname,
        headers: requestHeaders,
        // Pin socket connection strictly to the pre-validated IP address (zero second DNS lookup!)
        lookup: (_host, opts, cb) => {
          const allRequested =
            typeof opts === 'object' &&
            opts !== null &&
            'all' in opts &&
            Boolean(opts.all);
          if (allRequested) {
            (
              cb as (
                err: NodeJS.ErrnoException | null,
                addresses: Array<{ address: string; family: number }>
              ) => void
            )(null, [
              { address: pinnedTarget.address, family: pinnedTarget.family },
            ]);
          } else {
            (
              cb as (
                err: NodeJS.ErrnoException | null,
                address: string,
                family: number
              ) => void
            )(null, pinnedTarget.address, pinnedTarget.family);
          }
        },
      },
      (res) => {
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          res.resume();
          finishError(
            new Error(
              `SSRF & redirect guard blocked HTTP ${status} redirect from "${origin}".`
            )
          );
          return;
        }

        const respHeaders: Record<string, string> = {};
        for (const [hk, hv] of Object.entries(res.headers)) {
          if (typeof hv === 'string') respHeaders[hk.toLowerCase()] = hv;
          else if (Array.isArray(hv)) respHeaders[hk.toLowerCase()] = hv.join(', ');
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;

        res.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
          if (totalBytes < MAX_OUTBOUND_RESPONSE_BYTES) {
            const remaining = MAX_OUTBOUND_RESPONSE_BYTES - totalBytes;
            chunks.push(buf.subarray(0, remaining));
          }
          totalBytes += buf.length;
          if (totalBytes > MAX_OUTBOUND_RESPONSE_BYTES) {
            // Stop reading oversized external response body to prevent memory exhaustion
            res.destroy();
            if (!settled) {
              settled = true;
              clearTimeout(hardTimer);
              const responseText = Buffer.concat(chunks)
                .toString('utf8')
                .slice(0, 4000);
              resolve({
                ok: status >= 200 && status < 300,
                status,
                responseText,
                destinationOrigin: origin,
                headers: respHeaders,
              });
            }
          }
        });

        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(hardTimer);
          const responseText = Buffer.concat(chunks)
            .toString('utf8')
            .slice(0, 4000);
          resolve({
            ok: status >= 200 && status < 300,
            status,
            responseText,
            destinationOrigin: origin,
            headers: respHeaders,
          });
        });

        res.on('error', (err) => {
          finishError(err instanceof Error ? err : new Error(String(err)));
        });
      }
    );

    const hardTimer = setTimeout(() => {
      const timeoutErr = new Error(
        `Outbound HTTPS request to ${origin} timed out after ${timeoutMs}ms`
      );
      timeoutErr.name = 'AbortError';
      req.destroy(timeoutErr);
      finishError(timeoutErr);
    }, timeoutMs);

    req.on('error', (err) => {
      finishError(err instanceof Error ? err : new Error(String(err)));
    });

    if (payloadString !== null) {
      req.write(payloadString);
    }
    req.end();
  });
}

/**
 * Executes an outbound HTTPS JSON POST pinned to the exact SSRF-validated IP address
 * (eliminating DNS-rebinding TOCTOU), with TLS SNI preserved (`servername: hostname`),
 * HTTP redirects rejected, and streaming response size capped at 64 KB.
 */
export async function safeOutboundPostJson(params: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs?: number;
  dnsLookup?: DnsLookupFn;
}): Promise<{
  ok: boolean;
  status: number;
  responseText: string;
  destinationOrigin: string;
}> {
  const res = await safeOutboundHttpRequest({
    url: params.url,
    method: 'POST',
    headers: params.headers,
    body: params.body,
    timeoutMs: params.timeoutMs,
    dnsLookup: params.dnsLookup,
  });
  return {
    ok: res.ok,
    status: res.status,
    responseText: res.responseText.slice(0, 2000),
    destinationOrigin: res.destinationOrigin,
  };
}
