import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CardBoard,
  Footprint,
  Invite,
  InviteFail,
  MeetUrlFix,
  Neighbor,
  NeighborBoard,
  PartyCard,
  PeerProfile,
  ProfileBoard,
  PutProfileResult,
  ReportResult,
  Slot,
} from './meet.ts';

export interface HubAuthRecord {
  schema: 1;
  hubUrl: string;
  petId: string;
  token: string;
  legacyUid: string | null;
  displayName: string;
  updatedAt: string;
}

export interface HubRequestResult<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  errorCode?: string;
  errorMessage?: string;
}

export interface HubAuthFailureEvent {
  hubUrl: string;
  token: string;
  status: number;
  code: string;
  message: string;
}

const authFailureListeners = new Set<(ev: HubAuthFailureEvent) => void>();

/** 注册 Hub 运行期 401/403 致命鉴权错误监听器，返回取消订阅函数。 */
export function onHubAuthFailure(listener: (ev: HubAuthFailureEvent) => void): () => void {
  authFailureListeners.add(listener);
  return () => { authFailureListeners.delete(listener); };
}

function notifyAuthFailure(ev: HubAuthFailureEvent): void {
  for (const fn of authFailureListeners) {
    try { fn(ev); } catch { /* 监听器异常不得影响主请求流程 */ }
  }
}

const TIMEOUT_MS = 5000;

export function normalizeHubUrl(raw: unknown): MeetUrlFix {
  const original = String(raw ?? '');
  let s = original
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u00a0\u3000]/g, ' ')
    .trim();
  if (!s) return { base: '', fixed: '', error: '' };

  s = s.replace(/^["'“”‘’`<(<\s]+|["'“”‘’`>)\s]+$/g, '').trim();
  if (!s) return { base: '', fixed: '', error: '只填了空格或引号，没有网址' };

  const hadProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (hadProto && !/^https?:\/\//i.test(s)) {
    const scheme = s.slice(0, s.indexOf('://'));
    return { base: '', fixed: '', error: `只认 http:// 或 https://，不认 ${scheme}://` };
  }
  const withProto = hadProto ? s : `https://${s}`;

  let u: URL;
  try {
    u = new URL(withProto);
  } catch {
    return { base: '', fixed: '', error: '读不成合法网址（检查一下拼写和空格）' };
  }
  if (!u.hostname) return { base: '', fixed: '', error: '地址里没有域名' };

  let path = u.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(v1(\/.*)?|health|sight(\/.*)?)$/i, '');
  const base = `${u.protocol}//${u.host}${path}`;
  if (base === original) return { base, fixed: '', error: '' };
  const notes: string[] = [];
  if (!hadProto) notes.push('补上了 https://');
  if (u.search || u.hash) notes.push('清掉了后面多余的参数');
  if (path !== u.pathname.replace(/\/+$/, '')) notes.push('剪掉了后面的接口路径');
  return { base, fixed: notes.join('、') || '清掉了多余空格或斜杠', error: '' };
}

export function normHubBaseUrl(raw: unknown): string {
  return normalizeHubUrl(raw).base;
}

export function hubAuthFilePath(dataDir: string): string {
  return join(dataDir, 'coopanion-hub-auth.json');
}

function parseHubAuthEntry(raw: any): HubAuthRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.petId !== 'string' || !raw.petId.trim()) return null;
  if (typeof raw.token !== 'string' || !raw.token.trim()) return null;
  if (typeof raw.hubUrl !== 'string' || !normHubBaseUrl(raw.hubUrl)) return null;
  return {
    schema: 1,
    hubUrl: normHubBaseUrl(raw.hubUrl),
    petId: raw.petId.trim(),
    token: raw.token.trim(),
    legacyUid: typeof raw.legacyUid === 'string' && raw.legacyUid.trim() ? raw.legacyUid.trim() : null,
    displayName: typeof raw.displayName === 'string' ? raw.displayName.trim() : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

export function readHubAuth(dataDir: string, targetHubUrl?: string): HubAuthRecord | null {
  try {
    const file = hubAuthFilePath(dataDir);
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as any;
    if (!raw || typeof raw !== 'object') return null;
    const top = parseHubAuthEntry(raw);
    const want = targetHubUrl ? normHubBaseUrl(targetHubUrl) : '';
    if (!want) return top;
    if (top && top.hubUrl === want) return top;
    if (raw.byHub && typeof raw.byHub === 'object') {
      const hit = parseHubAuthEntry(raw.byHub[want]);
      if (hit && hit.hubUrl === want) return hit;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeHubAuthAtomic(dataDir: string, rec: HubAuthRecord): void {
  mkdirSync(dataDir, { recursive: true });
  const target = hubAuthFilePath(dataDir);
  const byHub: Record<string, HubAuthRecord> = {};
  try {
    if (existsSync(target)) {
      const prevRaw = JSON.parse(readFileSync(target, 'utf8')) as any;
      const prevTop = parseHubAuthEntry(prevRaw);
      if (prevTop) byHub[prevTop.hubUrl] = prevTop;
      if (prevRaw && typeof prevRaw === 'object' && prevRaw.byHub && typeof prevRaw.byHub === 'object') {
        for (const [k, v] of Object.entries(prevRaw.byHub)) {
          const entry = parseHubAuthEntry(v);
          if (entry) byHub[normHubBaseUrl(k) || entry.hubUrl] = entry;
        }
      }
    }
  } catch { /* ignore */ }
  const normRec: HubAuthRecord = { ...rec, hubUrl: normHubBaseUrl(rec.hubUrl) };
  byHub[normRec.hubUrl] = normRec;
  const payload = { ...normRec, byHub };
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, target);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** 按既有约定只读探测本地老服 uid，不主动写文件：meet-uid.txt -> life-town-uid.txt。 */
export function probeLegacyUid(dataDir: string): string | undefined {
  for (const name of ['meet-uid.txt', 'life-town-uid.txt']) {
    try {
      const p = join(dataDir, name);
      if (!existsSync(p)) continue;
      const v = readFileSync(p, 'utf8').trim();
      if (/^[a-f0-9]{16,64}$/i.test(v)) return v;
    } catch { /* ignore */ }
  }
  return undefined;
}

export async function hubRequest<T = any>(
  hubUrl: string,
  path: string,
  opts: {
    method?: string;
    token?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<HubRequestResult<T>> {
  const root = normHubBaseUrl(hubUrl);
  if (!root) {
    return { ok: false, status: 0, errorCode: 'NO_HUB_URL', errorMessage: '未配置 Hub 服务地址' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.token) {
    headers.authorization = `Bearer ${opts.token}`;
  }
  let rawBody: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    rawBody = JSON.stringify(opts.body);
  }
  try {
    const res = await fetch(`${root}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: rawBody,
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok === false) {
      const errCode = typeof json?.error?.code === 'string' ? json.error.code : `HTTP_${res.status}`;
      const errMsg = typeof json?.error?.message === 'string' ? json.error.message : `Hub 返回 HTTP ${res.status}`;
      if (
        opts.token
        && (res.status === 401 || (res.status === 403 && (errCode === 'ACCOUNT_BANNED' || errCode === 'RENAME_REQUIRED')))
      ) {
        notifyAuthFailure({
          hubUrl: root,
          token: opts.token,
          status: res.status,
          code: errCode,
          message: errMsg,
        });
      }
      return {
        ok: false,
        status: res.status,
        errorCode: errCode,
        errorMessage: errMsg,
      };
    }
    return {
      ok: true,
      status: res.status,
      data: (json.data ?? json) as T,
    };
  } catch (e) {
    const isAbort = (e as Error)?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      errorCode: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR',
      errorMessage: isAbort ? 'Hub 连接超时' : ((e as Error)?.message || 'Hub 网络不可达'),
    };
  } finally {
    clearTimeout(timer);
  }
}

const HUB_AUTH_LOCK_FILENAME = 'coopanion-hub-auth.lock';
const HUB_AUTH_LOCK_STALE_MS = 15_000;
const HUB_AUTH_LOCK_WAIT_MS = 5_000;

async function withHubAuthLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  if (!dataDir) return fn();
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    return fn();
  }
  const lockPath = join(dataDir, HUB_AUTH_LOCK_FILENAME);
  const deadline = Date.now() + HUB_AUTH_LOCK_WAIT_MS;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      try { writeFileSync(fd, `${process.pid}\n`, 'utf8'); } catch { /* ignore */ }
      closeSync(fd);
      acquired = true;
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') break;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > HUB_AUTH_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  try {
    return await fn();
  } finally {
    if (acquired) {
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

export async function ensureHubAuth(opts: {
  hubUrl: string;
  dataDir: string;
  displayName: string;
  bio?: string;
  timeoutMs?: number;
  conflictRetryDelaysMs?: readonly number[];
}): Promise<{ ok: boolean; auth?: HubAuthRecord; created?: boolean; code?: string; reason?: string }> {
  const root = normHubBaseUrl(opts.hubUrl);
  if (!root) return { ok: false, code: 'NO_HUB_URL', reason: '未配置 Hub 服务地址' };

  const existing = readHubAuth(opts.dataDir, root);
  if (existing && existing.hubUrl === root) {
    return { ok: true, auth: existing, created: false };
  }

  return withHubAuthLock(opts.dataDir, async () => {
    const racedBefore = readHubAuth(opts.dataDir, root);
    if (racedBefore && racedBefore.hubUrl === root) {
      return { ok: true, auth: racedBefore, created: false };
    }

    const legacyUid = probeLegacyUid(opts.dataDir);
    const res = await hubRequest<{
      petId: string;
      displayName: string;
      legacyUid: string | null;
      token: string;
    }>(root, '/v1/core/pets/register', {
      method: 'POST',
      body: {
        displayName: (opts.displayName || '大肥鱼').slice(0, 32),
        ...(legacyUid ? { legacyUid } : {}),
        ...(opts.bio ? { bio: opts.bio.slice(0, 300) } : {}),
      },
      timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
    });

    if (!res.ok || !res.data?.petId || !res.data?.token) {
      if (res.errorCode === 'LEGACY_UID_CLAIMED') {
        // 双扩展并发首次启动时，可能一方刚完成认领写盘，另一方紧随其后吃到 409；轮询重读共享凭据自愈
        const delays = opts.conflictRetryDelaysMs ?? [0, 150, 350, 750];
        for (const ms of delays) {
          if (ms > 0) await new Promise((r) => setTimeout(r, ms));
          const raced = readHubAuth(opts.dataDir, root);
          if (raced && raced.hubUrl === root) {
            return { ok: true, auth: raced, created: false };
          }
        }
        return {
          ok: false,
          code: 'LEGACY_UID_CLAIMED',
          reason: `老服 uid（${legacyUid?.slice(0, 8)}…）已被 Hub 认领，且本机缺少 coopanion-hub-auth.json；请联系总服管理员通过 tokens/reset 核实找回，绝不重复建号。`,
        };
      }
      return {
        ok: false,
        code: res.errorCode || 'REGISTER_FAILED',
        reason: res.errorMessage || 'Hub 身份注册失败',
      };
    }

    const rec: HubAuthRecord = {
      schema: 1,
      hubUrl: root,
      petId: res.data.petId,
      token: res.data.token,
      legacyUid: res.data.legacyUid ?? legacyUid ?? null,
      displayName: res.data.displayName || opts.displayName || '大肥鱼',
      updatedAt: new Date().toISOString(),
    };
    try {
      writeHubAuthAtomic(opts.dataDir, rec);
    } catch (e) {
      return {
        ok: false,
        code: 'AUTH_WRITE_FAILED',
        reason: `Hub 身份写入本机失败（${e instanceof Error ? e.message : String(e)}）`,
      };
    }
    return { ok: true, auth: rec, created: true };
  });
}

const cleanStr = (s: unknown) => String(s ?? '').trim();
const flatStr = (s: unknown, max: number) =>
  cleanStr(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function mapHubInvites(raw: unknown, maxLimit = 6): Invite[] {
  if (!Array.isArray(raw)) return [];
  const out: Invite[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = cleanStr(o.id).toLowerCase();
    if (!/^[a-f0-9]{16}$/.test(id)) continue;
    const pet = flatStr(o.pet, 24);
    const petId = cleanStr(o.petId);
    const to = flatStr(o.to, 40);
    if (!pet || !to) continue;
    const meetRaw = flatStr(o.meet, 40);
    const paceRaw = Math.round(Number(o.pace) || 0);
    out.push({
      id,
      ...(petId ? { petId } : {}),
      pet,
      to,
      days: Math.min(30, Math.max(1, Math.round(Number(o.days) || 1))),
      note: flatStr(o.note, 60),
      meetCity: meetRaw && meetRaw !== to ? meetRaw : '',
      pace: paceRaw > 0 ? Math.min(240, paceRaw) : 0,
      mode: flatStr(o.mode, 40),
      fromCity: flatStr(o.from, 40),
      near: o.near === true,
      postedAt: typeof o.at === 'string' ? o.at.slice(0, 40) : '',
    });
    if (out.length >= maxLimit) break;
  }
  return out;
}

export async function hubReportPresence(
  hubUrl: string,
  token: string,
  cityId: string,
  dateKey: string,
  slot: Slot,
  doing: string,
): Promise<ReportResult> {
  const res = await hubRequest(hubUrl, '/v1/journey/presence', {
    method: 'POST',
    token,
    body: {
      cityId,
      dateKey,
      slot,
      doing: cleanStr(doing).slice(0, 40),
    },
  });
  return res.ok ? { ok: true, why: '' } : { ok: false, why: res.errorMessage || `Hub 返回 ${res.status}` };
}

export async function hubFindNeighbors(
  hubUrl: string,
  token: string,
  petName: string,
  cityId: string,
  slot: Slot | 'all',
  limit = 3,
  windowMs?: number,
): Promise<NeighborBoard> {
  const q = new URLSearchParams({
    city: cityId,
    slot,
    limit: String(Math.max(1, Math.min(20, Math.floor(limit) || 3))),
    ...(windowMs !== undefined && Number.isFinite(windowMs) && windowMs > 0
      ? { window: String(Math.round(windowMs)) }
      : {}),
  });
  const res = await hubRequest<{ list?: unknown[]; pool?: number; here?: number }>(
    hubUrl,
    `/v1/journey/presence?${q.toString()}`,
    { token },
  );
  if (!res.ok || !res.data || !Array.isArray(res.data.list)) {
    return { list: [], pool: 0, here: 0, ok: false };
  }
  const list: Neighbor[] = res.data.list
    .filter((x): x is Neighbor => !!x && typeof x === 'object'
      && typeof (x as any).pet === 'string' && typeof (x as any).doing === 'string')
    .map((x) => ({ pet: x.pet.slice(0, 24), doing: x.doing.slice(0, 40) }))
    .filter((x) => Boolean(x.pet))
    .slice(0, limit);
  return {
    list,
    pool: typeof res.data.pool === 'number' && res.data.pool > 0 ? Math.floor(res.data.pool) : 0,
    here: typeof res.data.here === 'number' && res.data.here > 0 ? Math.floor(res.data.here) : 0,
    ok: true,
  };
}

export async function hubReportFootprint(
  hubUrl: string,
  token: string,
  cityId: string,
): Promise<boolean> {
  const res = await hubRequest(hubUrl, '/v1/journey/footprints', {
    method: 'POST',
    token,
    body: { cityId },
  });
  return res.ok;
}

export async function hubFetchFootprints(
  hubUrl: string,
  token: string,
): Promise<Footprint[]> {
  const res = await hubRequest<{ places?: unknown[] }>(hubUrl, '/v1/journey/footprints', { token });
  if (!res.ok || !res.data || !Array.isArray(res.data.places)) return [];
  return res.data.places
    .filter((p): p is Footprint => !!p && typeof p === 'object' && typeof (p as any).city === 'string')
    .map((p) => ({
      city: String((p as any).city),
      first: String((p as any).first ?? ''),
      last: String((p as any).last ?? ''),
      visits: Number((p as any).visits) || 1,
    }));
}

export async function hubReportSignpost(
  hubUrl: string,
  token: string,
  cityId: string,
  text: string,
): Promise<boolean> {
  const res = await hubRequest(hubUrl, '/v1/journey/signposts', {
    method: 'POST',
    token,
    body: { cityId, text: cleanStr(text).slice(0, 40) },
  });
  return res.ok;
}

export async function hubFetchSignposts(
  hubUrl: string,
  token: string,
  cityId: string,
): Promise<{ pet: string; text: string }[]> {
  const q = new URLSearchParams({ city: cityId });
  const res = await hubRequest<{ list?: unknown[] }>(hubUrl, `/v1/journey/signposts?${q.toString()}`, { token });
  if (!res.ok || !res.data || !Array.isArray(res.data.list)) return [];
  return res.data.list
    .filter((x): x is { pet: string; text: string } => !!x && typeof x === 'object'
      && typeof (x as any).pet === 'string' && typeof (x as any).text === 'string')
    .map((x) => ({ pet: x.pet.slice(0, 24), text: x.text.slice(0, 40) }))
    .filter((x) => x.pet && x.text);
}

export async function hubSendInvite(
  hubUrl: string,
  token: string,
  args: { from: string; to: string; days: number; note: string; meetCity?: string; pace?: number; mode?: string },
): Promise<{ ok: true; id: string } | InviteFail> {
  const meetCity = cleanStr(args.meetCity);
  const meet = meetCity && meetCity !== args.to ? meetCity : '';
  const pace = Math.min(240, Math.max(1, Math.round(Number(args.pace) || 1)));
  const res = await hubRequest<{ id?: string }>(hubUrl, '/v1/journey/invites', {
    method: 'POST',
    token,
    body: {
      from: args.from,
      to: args.to,
      days: Math.min(30, Math.max(1, Math.round(args.days) || 1)),
      note: flatStr(args.note, 60),
      meet,
      pace,
      mode: flatStr(args.mode, 40),
    },
  });
  if (!res.ok || !res.data) {
    return { ok: false, reason: res.errorMessage || '邀约没发出去' };
  }
  const id = typeof res.data.id === 'string' ? res.data.id.slice(0, 32) : '';
  return { ok: true, id };
}

export async function hubListInvites(
  hubUrl: string,
  token: string,
  cityId: string,
): Promise<{ ok: true; list: Invite[] } | InviteFail> {
  const q = new URLSearchParams({ city: cityId });
  const res = await hubRequest<{ list?: unknown[] }>(hubUrl, `/v1/journey/invites?${q.toString()}`, { token });
  if (!res.ok || !res.data) {
    return { ok: false, reason: res.errorMessage || '查不到全服邀约' };
  }
  return { ok: true, list: mapHubInvites(res.data.list) };
}

export async function hubFetchStatus(
  hubUrl: string,
  token: string,
  cityId: string,
): Promise<{ ok: true; pool: number; invites: Invite[]; mineTaken: number } | InviteFail> {
  const q = new URLSearchParams({ city: cityId });
  const res = await hubRequest<{ pool?: number; list?: unknown[]; mineTaken?: number }>(
    hubUrl,
    `/v1/journey/status?${q.toString()}`,
    { token },
  );
  if (!res.ok || !res.data) {
    return { ok: false, reason: res.errorMessage || '状态查询失败' };
  }
  return {
    ok: true,
    pool: Math.max(0, Math.floor(Number(res.data.pool) || 0)),
    invites: mapHubInvites(res.data.list),
    mineTaken: Math.max(0, Math.floor(Number(res.data.mineTaken) || 0)),
  };
}

export async function hubMyTakenInvites(
  hubUrl: string,
  token: string,
): Promise<{ ok: true; list: Invite[] } | InviteFail> {
  const res = await hubRequest<{ list?: unknown[] }>(hubUrl, '/v1/journey/invites?mine=1', { token });
  if (!res.ok || !res.data) {
    return { ok: false, reason: res.errorMessage || '查询已接邀约失败' };
  }
  return { ok: true, list: mapHubInvites(res.data.list, 20) };
}

export async function hubAckTakenInvites(
  hubUrl: string,
  token: string,
  inviteIds: readonly string[],
  pairs?: readonly { inviteId: string; memberPetId: string }[],
): Promise<boolean> {
  const validPairs = (pairs ?? [])
    .map((p) => ({ inviteId: cleanStr(p.inviteId).toLowerCase(), memberPetId: cleanStr(p.memberPetId) }))
    .filter((p) => /^[a-f0-9]{16}$/.test(p.inviteId) && Boolean(p.memberPetId))
    .slice(0, 100);
  const validIds = inviteIds.map((x) => cleanStr(x).toLowerCase()).filter((x) => /^[a-f0-9]{16}$/.test(x)).slice(0, 50);
  if (!validPairs.length && !validIds.length) return true;
  const res = await hubRequest(hubUrl, '/v1/journey/invites/ack', {
    method: 'POST',
    token,
    body: {
      ...(validPairs.length ? { pairs: validPairs } : {}),
      ...(validIds.length ? { inviteIds: validIds } : {}),
    },
  });
  return res.ok;
}

export async function hubAcceptInvite(
  hubUrl: string,
  token: string,
  id: string,
): Promise<{
  readonly ok: true;
  readonly withPet: string;
  readonly to: string;
  readonly days: number;
  readonly note: string;
  readonly meetCity: string;
  readonly pace: number;
  readonly mode: string;
  readonly postedAt: string;
} | InviteFail> {
  const got = /[a-f0-9]{16}/i.exec(cleanStr(id).slice(0, 200));
  const inviteId = got ? got[0].toLowerCase() : '';
  if (!inviteId) return { ok: false, reason: '这条邀约的编号不对' };

  const res = await hubRequest<Record<string, unknown>>(
    hubUrl,
    `/v1/journey/invites/${encodeURIComponent(inviteId)}/accept`,
    {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': `accept-${inviteId}-${randomUUID()}` },
      body: {},
    },
  );
  if (!res.ok || !res.data) {
    return { ok: false, reason: res.errorMessage || '接约没成功' };
  }
  const b = res.data;
  const pet = flatStr(b.with, 24);
  const to = typeof b.to === 'string' ? b.to.slice(0, 40) : '';
  if (!pet || !to) return { ok: false, reason: '服务器回的内容缺了「跟谁、去哪」' };
  const meetRaw = flatStr(b.meet, 40);
  const paceRaw = Math.round(Number(b.pace) || 0);
  return {
    ok: true,
    withPet: pet,
    to,
    days: Math.min(30, Math.max(1, Math.round(Number(b.days) || 1))),
    note: flatStr(b.note, 60),
    meetCity: meetRaw && meetRaw !== to ? meetRaw : '',
    pace: paceRaw > 0 ? Math.min(240, paceRaw) : 0,
    mode: flatStr(b.mode, 40),
    postedAt: typeof b.at === 'string' ? b.at.slice(0, 40) : '',
  };
}

export async function hubPutCard(
  hubUrl: string,
  token: string,
  inviteId: string,
  note: string,
  contact: string,
): Promise<boolean> {
  const id = cleanStr(inviteId).toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(id)) return false;
  if (!cleanStr(note) && !cleanStr(contact)) return false;
  const res = await hubRequest(hubUrl, '/v1/journey/cards', {
    method: 'POST',
    token,
    body: {
      inviteId: id,
      note: cleanStr(note).slice(0, 40),
      contact: cleanStr(contact).slice(0, 40),
    },
  });
  return res.ok;
}

export async function hubFetchCards(
  hubUrl: string,
  token: string,
  inviteId: string,
): Promise<CardBoard> {
  const id = cleanStr(inviteId).toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(id)) return { cards: [], mine: null };
  const q = new URLSearchParams({ invite_id: id });
  const res = await hubRequest<{ cards?: unknown[]; mine?: { note?: unknown; contact?: unknown } | null }>(
    hubUrl,
    `/v1/journey/cards?${q.toString()}`,
    { token },
  );
  if (!res.ok || !res.data) return { cards: [], mine: null };
  const cards: PartyCard[] = Array.isArray(res.data.cards)
    ? res.data.cards
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({
        pet: cleanStr(x.pet).slice(0, 24),
        note: cleanStr(x.note).slice(0, 40),
        contact: cleanStr(x.contact).slice(0, 40),
        at: cleanStr(x.at).slice(0, 32),
      }))
      .filter((c) => c.pet && (c.note || c.contact))
      .slice(0, 8)
    : [];
  const m = res.data.mine;
  const mine = m && typeof m === 'object'
    ? { note: cleanStr(m.note).slice(0, 40), contact: cleanStr(m.contact).slice(0, 40) }
    : null;
  return { cards, mine };
}

export async function hubPutProfile(
  hubUrl: string,
  token: string,
  text: string,
): Promise<PutProfileResult> {
  const res = await hubRequest(hubUrl, '/v1/journey/profile', {
    method: 'PUT',
    token,
    body: { text: cleanStr(text).slice(0, 120) },
  });
  return res.ok
    ? { ok: true }
    : { ok: false, reason: res.errorMessage || `Hub 返回 ${res.status}` };
}

export async function hubFetchProfiles(
  hubUrl: string,
  token: string,
): Promise<ProfileBoard> {
  const res = await hubRequest<{ mine?: { text?: unknown } | null; others?: unknown[] }>(
    hubUrl,
    '/v1/journey/profile',
    { token },
  );
  if (!res.ok || !res.data) return { mine: null, others: [] };
  const mineText = res.data.mine && typeof res.data.mine === 'object' ? cleanStr(res.data.mine.text).slice(0, 120) : '';
  const others: PeerProfile[] = Array.isArray(res.data.others)
    ? res.data.others
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({
        pet: cleanStr(x.pet).slice(0, 24),
        text: cleanStr(x.text).slice(0, 120),
        at: cleanStr(x.at).slice(0, 32),
      }))
      .filter((x) => x.pet && x.text)
      .slice(0, 20)
    : [];
  return { mine: mineText ? { text: mineText } : null, others };
}

export async function hubPutExtProfile(
  hubUrl: string,
  token: string,
  body: { schemaVer: number; summaryText: string; payload: Record<string, unknown> },
): Promise<boolean> {
  const res = await hubRequest(hubUrl, '/v1/core/pets/me/ext/journey', {
    method: 'PUT',
    token,
    body,
  });
  return res.ok;
}
