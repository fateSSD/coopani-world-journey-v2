/**
 * 生图提示词多模型方案、草稿对比预览与历史备份回滚引擎。
 *
 * 原作者：frost77r（整合自 `cortico-world-journey-prompt-editor` v1.1.0，改写为内置进程内闭环）。
 * 存储目录保持 `<dataDir>/journey-prompt-editor/`，确保原独立插件用户的历史备份与模型方案无缝沿用。
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolDef } from 'cortico/core/types.ts';
import { presetDefaults } from './image-backend.ts';

export const PROMPT_EDITOR_AUTHOR = 'frost77r';
export const PROMPT_EDITOR_STORE_DIR_NAME = 'journey-prompt-editor';

export const PROMPT_FIELDS = ['imageStyle', 'imageCast', 'imageStyleCast'] as const;
export type PromptField = (typeof PROMPT_FIELDS)[number];
export type PromptFields = Record<PromptField, string>;

export const FIELD_LABELS: Record<PromptField, string> = {
  imageStyle: '默认画风 (imageStyle)',
  imageCast: '出镜角色描述 (imageCast)',
  imageStyleCast: '出镜专属画风 (imageStyleCast)',
};

export const ALLOWED_PROTOCOLS = ['', 'openai', 'comfyui'] as const;
export const ALLOWED_PRESETS = ['', 'custom', 'doubao', 'openai', 'qwen'] as const;

export const DEFAULT_MAX_SNAPSHOTS = 30;
export const MIN_SNAPSHOTS = 5;
export const MAX_SNAPSHOTS_LIMIT = 200;
export const DEFAULT_AUTO_SWITCH = true;

export type PromptHistoryAction = 'save' | 'rollback' | 'profile-apply' | 'auto-switch';
const VALID_ACTIONS = new Set<PromptHistoryAction>(['save', 'rollback', 'profile-apply', 'auto-switch']);

export interface ImageBackendMeta {
  protocol: 'openai' | 'comfyui';
  preset: 'custom' | 'doubao' | 'openai' | 'qwen';
  model: string;
  effectiveModel: string;
  api: string;
  workflow: string;
  signature: string;
  displayLabel: string;
}

export interface ProfileMatchRule {
  model: string;
  preset: string;
  protocol: string;
  api: string;
}

export interface StoredPromptProfile {
  id: string;
  name: string;
  match: ProfileMatchRule;
  fields: PromptFields;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptHistoryEntry {
  id: string;
  createdAt: string;
  action: PromptHistoryAction;
  reason: string;
  applyMode: string;
  restoredFrom?: string;
  profileId?: string;
  modelLabel?: string;
  changedFields: PromptField[];
  before: PromptFields;
  after: PromptFields;
}

export interface PromptDraftEntry {
  updatedAt: string;
  baseHash: string;
  reason: string;
  patch: Partial<PromptFields>;
}

export interface AutoSwitchRecord {
  at: string;
  trigger: string;
  fromModel: string;
  toModel: string;
  profileId: string;
  profileName: string;
  snapshotId: string;
  liveApplied: boolean;
}

export interface PromptSyncState {
  lastSeenSignature: string;
  lastSeenLabel: string;
  lastAutoSwitch: AutoSwitchRecord | null;
}

export interface PromptDiffChange {
  field: PromptField;
  label: string;
  before: string;
  after: string;
  beforeLength: number;
  afterLength: number;
  deltaLength: number;
}

export interface PromptDiffResult {
  hasChanges: boolean;
  changedFields: PromptField[];
  changes: PromptDiffChange[];
  diffMarkdown: string;
}

export interface PromptBridgeReadResult {
  fields: PromptFields;
  backend: ImageBackendMeta;
  source: string;
  liveConnected: boolean;
  webUrl?: string;
  rpcError?: string;
}

export interface PromptBridgeWriteResult {
  fields: PromptFields;
  backend: ImageBackendMeta;
  applyMode: string;
  liveApplied: boolean;
  webUrl?: string;
  rpcError?: string;
}

export interface PromptBridge {
  readPrompts(): Promise<PromptBridgeReadResult>;
  writePrompts(patch: Partial<PromptFields>): Promise<PromptBridgeWriteResult>;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function assertPlainObject(value: unknown, label = '参数'): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label}必须是普通对象`);
  }
}

export function assertAllowedKeys(obj: unknown, allowedKeys: readonly string[], label = '参数'): void {
  assertPlainObject(obj, label);
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${label}包含未允许字段：${String(key)}`);
    }
  }
}

export function normalizePromptValue(value: string): string {
  return value.trim();
}

export function readPromptFieldsFromObject(
  source: unknown,
  { strict = false }: { strict?: boolean } = {},
): PromptFields {
  const obj = isPlainObject(source) ? source : {};
  const result: PromptFields = { imageStyle: '', imageCast: '', imageStyleCast: '' };
  for (const field of PROMPT_FIELDS) {
    const raw = Object.hasOwn(obj, field) ? obj[field] : '';
    if (raw === undefined || raw === null) {
      result[field] = '';
      continue;
    }
    if (typeof raw !== 'string') {
      if (strict) throw new TypeError(`${field} 必须是字符串`);
      result[field] = String(raw).trim();
      continue;
    }
    result[field] = normalizePromptValue(raw);
  }
  return result;
}

export function extractPromptPatch(
  args: Record<string, unknown>,
  { allowEmpty = true }: { allowEmpty?: boolean } = {},
): Partial<PromptFields> {
  const patch: Partial<PromptFields> = {};
  for (const field of PROMPT_FIELDS) {
    if (!Object.hasOwn(args, field) || args[field] === undefined) continue;
    if (typeof args[field] !== 'string') {
      throw new TypeError(`${field} 必须是字符串`);
    }
    patch[field] = normalizePromptValue(args[field] as string);
  }
  if (!allowEmpty && Object.keys(patch).length === 0) {
    throw new TypeError('至少需要提供 imageStyle、imageCast、imageStyleCast 中的一项');
  }
  return patch;
}

export function applyPromptPatch(baseFields: PromptFields, patch: Partial<PromptFields>): PromptFields {
  const next: PromptFields = { ...baseFields };
  for (const field of PROMPT_FIELDS) {
    if (Object.hasOwn(patch, field) && typeof patch[field] === 'string') {
      next[field] = patch[field] as string;
    }
  }
  return next;
}

export function computeFieldsHash(fields: Partial<PromptFields>): string {
  const canonical = JSON.stringify({
    imageStyle: fields.imageStyle ?? '',
    imageCast: fields.imageCast ?? '',
    imageStyleCast: fields.imageStyleCast ?? '',
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

export function effectiveCastStyleNote(fields: Partial<PromptFields>): string {
  if (!fields.imageCast) {
    return '当前 imageCast 为空（画面默认不含出镜角色），生图使用 imageStyle。';
  }
  if (!fields.imageStyleCast) {
    return '当前 imageStyleCast 为空，有角色出镜时会自动回退使用 imageStyle。';
  }
  return '当前已单独配置 imageStyleCast：无角色出镜用 imageStyle，有角色出镜用 imageStyleCast。';
}

export function buildPromptDiff(before: PromptFields, after: PromptFields): PromptDiffResult {
  const changes: PromptDiffChange[] = [];
  for (const field of PROMPT_FIELDS) {
    const oldVal = before[field] ?? '';
    const newVal = after[field] ?? '';
    if (oldVal !== newVal) {
      changes.push({
        field,
        label: FIELD_LABELS[field],
        before: oldVal,
        after: newVal,
        beforeLength: oldVal.length,
        afterLength: newVal.length,
        deltaLength: newVal.length - oldVal.length,
      });
    }
  }

  if (changes.length === 0) {
    return {
      hasChanges: false,
      changedFields: [],
      changes: [],
      diffMarkdown: '无变更：修改后的提示词与当前生效配置完全一致。',
    };
  }

  const sections = changes.map((c) => {
    const beforeDisplay = c.before === '' ? '（空）' : c.before;
    const afterDisplay = c.after === '' ? '（空）' : c.after;
    const deltaSign = c.deltaLength > 0 ? `+${c.deltaLength}` : `${c.deltaLength}`;
    return [
      `### ${c.label}（${c.beforeLength} → ${c.afterLength} 字，${deltaSign}）`,
      `- 修改前：${beforeDisplay}`,
      `- 修改后：${afterDisplay}`,
    ].join('\n');
  });

  return {
    hasChanges: true,
    changedFields: changes.map((c) => c.field),
    changes,
    diffMarkdown: sections.join('\n\n'),
  };
}

export function summarizeText(text: string, maxChars = 60): string {
  if (!text) return '（空）';
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars - 1)}…`;
}

function cleanStr(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function basenameOf(filePath: string): string {
  const s = cleanStr(filePath);
  if (!s) return '';
  const parts = s.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? s;
}

/**
 * 解析当前生效的生图模型与后端标识。
 * 兼容 imageSettingsSnapshot 返回结构与 worlds.journey 配置结构。
 */
export function resolveImageBackendMeta(raw: unknown): ImageBackendMeta {
  const obj = isPlainObject(raw) ? raw : {};
  const rawProtocol = cleanStr(obj.protocol ?? obj.imageProtocol);
  const protocol: 'openai' | 'comfyui' = /^comfy/i.test(rawProtocol) ? 'comfyui' : 'openai';

  const rawPreset = cleanStr(obj.preset ?? obj.imagePreset).toLowerCase();
  const preset: ImageBackendMeta['preset'] =
    rawPreset === 'doubao' || rawPreset === 'openai' || rawPreset === 'qwen' || rawPreset === 'custom'
      ? rawPreset
      : 'custom';

  const presetInfo =
    (isPlainObject(obj.presets) && isPlainObject(obj.presets[preset]))
      ? obj.presets[preset]
      : (preset !== 'custom' ? presetDefaults(preset) : null);

  const rawModel = cleanStr(obj.model ?? obj.imageModel);
  const model = protocol === 'comfyui' ? '' : rawModel;
  const api = cleanStr(obj.api ?? obj.imageApi) || cleanStr(presetInfo?.api);
  const workflow = cleanStr(obj.workflow ?? obj.imageWorkflow);
  const workflowName = basenameOf(workflow);

  const effectiveModel = protocol === 'comfyui'
    ? (workflowName || 'comfyui')
    : (model || cleanStr(presetInfo?.model));

  const signature = [
    protocol,
    protocol === 'comfyui' ? '' : preset,
    effectiveModel.toLowerCase(),
    protocol === 'comfyui' ? workflowName.toLowerCase() : '',
  ].join('|');

  let displayLabel: string;
  if (protocol === 'comfyui') {
    displayLabel = workflowName ? `ComfyUI (${workflowName})` : 'ComfyUI（未选 workflow）';
  } else if (effectiveModel) {
    displayLabel = preset !== 'custom'
      ? `${effectiveModel} (${preset})`
      : `${effectiveModel} (openai/custom)`;
  } else {
    displayLabel = preset !== 'custom' ? `${preset}（未填模型）` : '未配置生图模型';
  }

  return {
    protocol,
    preset: protocol === 'comfyui' ? 'custom' : preset,
    model,
    effectiveModel,
    api,
    workflow: workflowName,
    signature,
    displayLabel,
  };
}

export function slugifyProfileId(input: string, fallbackPrefix = 'profile'): string {
  const base = cleanStr(input)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || `${fallbackPrefix}-${Date.now().toString(36).slice(-6)}`;
}

export function validateProfileId(id: string): string {
  const cleaned = cleanStr(id);
  if (!cleaned) throw new TypeError('profileId 不能为空');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(cleaned)) {
    throw new TypeError('profileId 只能包含英文字母、数字、点、下划线和连字符，且以字母或数字开头（最多 64 字符）');
  }
  return cleaned;
}

export function normalizeMatchRule(raw: unknown): ProfileMatchRule {
  const obj = isPlainObject(raw) ? raw : {};
  const protocol = cleanStr(obj.protocol).toLowerCase();
  if (!(ALLOWED_PROTOCOLS as readonly string[]).includes(protocol)) {
    throw new TypeError(`matchProtocol 只能是空字符串、openai 或 comfyui，收到：${protocol}`);
  }
  const preset = cleanStr(obj.preset).toLowerCase();
  if (!(ALLOWED_PRESETS as readonly string[]).includes(preset)) {
    throw new TypeError(`matchPreset 只能是空字符串、custom、doubao、openai 或 qwen，收到：${preset}`);
  }
  return {
    model: cleanStr(obj.model),
    preset,
    protocol,
    api: cleanStr(obj.api),
  };
}

export function hasMatchCriteria(match: ProfileMatchRule): boolean {
  return Boolean(match.model || match.preset || match.protocol || match.api);
}

export function describeMatchRule(match: ProfileMatchRule): string {
  const parts: string[] = [];
  if (match.model) parts.push(`模型=${match.model}`);
  if (match.preset) parts.push(`预设=${match.preset}`);
  if (match.protocol) parts.push(`协议=${match.protocol}`);
  if (match.api) parts.push(`接口包含=${match.api}`);
  return parts.length ? parts.join('，') : '仅手动切换（未绑定模型规则）';
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchModelPattern(pattern: string, backend: ImageBackendMeta): { matched: boolean; score: number } {
  const pat = cleanStr(pattern);
  if (!pat) return { matched: true, score: 0 };

  const targets = [backend.effectiveModel, backend.model, backend.workflow]
    .map((s) => cleanStr(s))
    .filter(Boolean);
  if (targets.length === 0) return { matched: false, score: 0 };

  const patLower = pat.toLowerCase();
  if (targets.some((t) => t.toLowerCase() === patLower)) {
    return { matched: true, score: 100 };
  }
  if (pat.includes('*')) {
    const re = wildcardToRegExp(pat);
    if (targets.some((t) => re.test(t))) {
      return { matched: true, score: 70 + Math.min(20, pat.replace(/\*/g, '').length) };
    }
    return { matched: false, score: 0 };
  }
  if (targets.some((t) => t.toLowerCase().includes(patLower))) {
    return { matched: true, score: 50 + Math.min(15, pat.length) };
  }
  return { matched: false, score: 0 };
}

export function scoreProfileForBackend(profile: StoredPromptProfile, backend: ImageBackendMeta): number | null {
  const match = profile?.match;
  if (!match || !hasMatchCriteria(match)) return null;

  let score = 0;

  if (match.protocol) {
    if (backend.protocol !== match.protocol) return null;
    score += 10;
  }

  if (match.preset) {
    if (backend.protocol === 'comfyui' || backend.preset !== match.preset) return null;
    score += 20;
  }

  if (match.api) {
    if (!backend.api || !backend.api.toLowerCase().includes(match.api.toLowerCase())) {
      return null;
    }
    score += 30;
  }

  if (match.model) {
    const res = matchModelPattern(match.model, backend);
    if (!res.matched) return null;
    score += res.score;
  }

  return score;
}

export function matchProfileForBackend(
  profiles: readonly StoredPromptProfile[],
  backend: ImageBackendMeta,
): { profile: StoredPromptProfile; score: number } | null {
  let best: { profile: StoredPromptProfile; score: number } | null = null;
  for (const profile of profiles) {
    const score = scoreProfileForBackend(profile, backend);
    if (score === null) continue;
    if (
      !best
      || score > best.score
      || (score === best.score && String(profile.updatedAt ?? '') > String(best.profile.updatedAt ?? ''))
    ) {
      best = { profile, score };
    }
  }
  return best;
}

export function buildMatchRuleFromBackend(backend: ImageBackendMeta): ProfileMatchRule {
  if (backend.protocol === 'comfyui') {
    return {
      protocol: 'comfyui',
      preset: '',
      model: backend.workflow || '',
      api: '',
    };
  }
  return {
    protocol: 'openai',
    preset: backend.preset !== 'custom' ? backend.preset : '',
    model: backend.effectiveModel || backend.model || '',
    api: '',
  };
}

export function normalizeStoredProfile(raw: unknown): StoredPromptProfile | null {
  if (!isPlainObject(raw) || typeof raw.id !== 'string' || !raw.id.trim()) return null;
  let match: ProfileMatchRule;
  try {
    match = normalizeMatchRule(raw.match);
  } catch {
    match = { model: '', preset: '', protocol: '', api: '' };
  }
  return {
    id: raw.id.trim(),
    name: cleanStr(raw.name) || raw.id.trim(),
    match,
    fields: readPromptFieldsFromObject(raw.fields),
    note: cleanStr(raw.note),
    createdAt: cleanStr(raw.createdAt),
    updatedAt: cleanStr(raw.updatedAt),
  };
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const suffix = `${process.pid}-${randomUUID()}`;
  const tmpPath = `${filePath}.tmp-${suffix}`;
  const bakPath = `${filePath}.bak-${suffix}`;
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(tmpPath, serialized, 'utf8');

  if (!existsSync(filePath)) {
    renameSync(tmpPath, filePath);
    return;
  }

  renameSync(filePath, bakPath);
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      renameSync(bakPath, filePath);
    } catch {
      // 保留备份文件供手动恢复
    }
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }
  try {
    rmSync(bakPath, { force: true });
  } catch {
    // ignore
  }
}

export function clampMaxSnapshots(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isFinite(num)) return DEFAULT_MAX_SNAPSHOTS;
  return Math.min(MAX_SNAPSHOTS_LIMIT, Math.max(MIN_SNAPSHOTS, Math.round(num)));
}

function makeSnapshotId(now = new Date()): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
  const shortRand = randomUUID().replace(/-/g, '').slice(0, 6);
  return `snap-${stamp}-${shortRand}`;
}

export class PromptEditorStore {
  readonly storeDir: string;
  readonly historyPath: string;
  readonly draftPath: string;
  readonly profilesPath: string;
  readonly syncStatePath: string;
  private readonly getMaxSnapshots: () => number;

  constructor(dataDir: string, getMaxSnapshots: () => number = () => DEFAULT_MAX_SNAPSHOTS) {
    this.storeDir = join(dataDir, PROMPT_EDITOR_STORE_DIR_NAME);
    this.historyPath = join(this.storeDir, 'history.json');
    this.draftPath = join(this.storeDir, 'draft.json');
    this.profilesPath = join(this.storeDir, 'profiles.json');
    this.syncStatePath = join(this.storeDir, 'sync-state.json');
    this.getMaxSnapshots = getMaxSnapshots;
  }

  loadHistory(): PromptHistoryEntry[] {
    if (!existsSync(this.historyPath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.historyPath, 'utf8'));
    } catch {
      return [];
    }
    const items = Array.isArray(parsed)
      ? parsed
      : (isPlainObject(parsed) && Array.isArray(parsed.snapshots) ? parsed.snapshots : []);
    return items
      .filter((item): item is Record<string, unknown> => isPlainObject(item) && typeof item.id === 'string')
      .map((item) => ({
        id: item.id as string,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
        action: VALID_ACTIONS.has(item.action as PromptHistoryAction) ? (item.action as PromptHistoryAction) : 'save',
        reason: typeof item.reason === 'string' ? item.reason : '',
        applyMode: typeof item.applyMode === 'string' ? item.applyMode : 'unknown',
        restoredFrom: typeof item.restoredFrom === 'string' ? item.restoredFrom : undefined,
        profileId: typeof item.profileId === 'string' ? item.profileId : undefined,
        modelLabel: typeof item.modelLabel === 'string' ? item.modelLabel : undefined,
        changedFields: Array.isArray(item.changedFields)
          ? item.changedFields.filter((f): f is PromptField => (PROMPT_FIELDS as readonly string[]).includes(String(f)))
          : [],
        before: readPromptFieldsFromObject(item.before),
        after: readPromptFieldsFromObject(item.after),
      }));
  }

  appendSnapshot(opts: {
    action?: PromptHistoryAction;
    reason?: string;
    applyMode?: string;
    restoredFrom?: string;
    profileId?: string;
    modelLabel?: string;
    changedFields?: PromptField[];
    before: PromptFields;
    after: PromptFields;
    now?: Date;
  }): PromptHistoryEntry {
    const {
      action = 'save',
      reason = '',
      applyMode = 'live-inproc',
      restoredFrom,
      profileId,
      modelLabel,
      changedFields = [],
      before,
      after,
      now = new Date(),
    } = opts;
    const history = this.loadHistory();
    const entry: PromptHistoryEntry = {
      id: makeSnapshotId(now),
      createdAt: now.toISOString(),
      action: VALID_ACTIONS.has(action) ? action : 'save',
      reason,
      applyMode,
      ...(restoredFrom ? { restoredFrom } : {}),
      ...(profileId ? { profileId } : {}),
      ...(modelLabel ? { modelLabel } : {}),
      changedFields: [...changedFields],
      before: readPromptFieldsFromObject(before),
      after: readPromptFieldsFromObject(after),
    };
    const maxCount = clampMaxSnapshots(this.getMaxSnapshots());
    const next = [entry, ...history].slice(0, maxCount);
    writeJsonAtomic(this.historyPath, { version: 1, snapshots: next });
    return entry;
  }

  getSnapshot(snapshotId?: string): PromptHistoryEntry | null {
    const history = this.loadHistory();
    if (!snapshotId) return history[0] ?? null;
    return history.find((item) => item.id === snapshotId) ?? null;
  }

  clearHistory(): number {
    const count = this.loadHistory().length;
    if (existsSync(this.historyPath)) {
      rmSync(this.historyPath, { force: true });
    }
    return count;
  }

  historyStatText(): string {
    const history = this.loadHistory();
    if (!history.length) return '0 条备份';
    const kb = existsSync(this.historyPath)
      ? Math.max(1, Math.ceil(statSync(this.historyPath).size / 1024))
      : 0;
    return `${history.length} 条备份（${kb} KB）`;
  }

  loadDraft(): PromptDraftEntry | null {
    if (!existsSync(this.draftPath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.draftPath, 'utf8'));
    } catch {
      return null;
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.patch)) return null;
    const patch: Partial<PromptFields> = {};
    for (const field of PROMPT_FIELDS) {
      const v = parsed.patch[field];
      if (typeof v === 'string') patch[field] = v;
    }
    if (Object.keys(patch).length === 0) return null;
    return {
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      baseHash: typeof parsed.baseHash === 'string' ? parsed.baseHash : '',
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      patch,
    };
  }

  saveDraft(opts: { baseHash: string; patch: Partial<PromptFields>; reason?: string; now?: Date }): PromptDraftEntry {
    const { baseHash, patch, reason = '', now = new Date() } = opts;
    const entry: PromptDraftEntry = {
      updatedAt: now.toISOString(),
      baseHash,
      reason,
      patch: { ...patch },
    };
    writeJsonAtomic(this.draftPath, { version: 1, ...entry });
    return entry;
  }

  clearDraft(): boolean {
    if (existsSync(this.draftPath)) {
      rmSync(this.draftPath, { force: true });
      return true;
    }
    return false;
  }

  draftStatText(): string {
    const draft = this.loadDraft();
    if (!draft) return '无未保存草稿';
    const keys = Object.keys(draft.patch);
    return `1 份待保存草稿（涉及 ${keys.join('、')}）`;
  }

  loadProfiles(): StoredPromptProfile[] {
    if (!existsSync(this.profilesPath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.profilesPath, 'utf8'));
    } catch {
      return [];
    }
    const items = Array.isArray(parsed)
      ? parsed
      : (isPlainObject(parsed) && Array.isArray(parsed.profiles) ? parsed.profiles : []);
    return items.map(normalizeStoredProfile).filter((x): x is StoredPromptProfile => x !== null);
  }

  getProfile(profileId?: string): StoredPromptProfile | null {
    if (!profileId) return null;
    return this.loadProfiles().find((item) => item.id === profileId) ?? null;
  }

  upsertProfile(opts: {
    id: string;
    name?: string;
    match: ProfileMatchRule;
    fields: PromptFields;
    note?: string;
    now?: Date;
  }): { profile: StoredPromptProfile; created: boolean } {
    const { id, name, match, fields, note, now = new Date() } = opts;
    const profiles = this.loadProfiles();
    const idx = profiles.findIndex((item) => item.id === id);
    const ts = now.toISOString();
    const existing = idx >= 0 ? profiles[idx] : null;
    const entry: StoredPromptProfile = {
      id,
      name: name || existing?.name || id,
      match: {
        model: match.model ?? '',
        preset: match.preset ?? '',
        protocol: match.protocol ?? '',
        api: match.api ?? '',
      },
      fields: readPromptFieldsFromObject(fields),
      note: typeof note === 'string' ? note : (existing?.note ?? ''),
      createdAt: existing?.createdAt || ts,
      updatedAt: ts,
    };

    const next = idx >= 0
      ? profiles.map((item, i) => (i === idx ? entry : item))
      : [entry, ...profiles];

    writeJsonAtomic(this.profilesPath, { version: 1, profiles: next });
    return { profile: entry, created: idx < 0 };
  }

  deleteProfile(profileId: string): StoredPromptProfile | null {
    const profiles = this.loadProfiles();
    const target = profiles.find((item) => item.id === profileId);
    if (!target) return null;
    const next = profiles.filter((item) => item.id !== profileId);
    writeJsonAtomic(this.profilesPath, { version: 1, profiles: next });
    return target;
  }

  clearProfiles(): number {
    const count = this.loadProfiles().length;
    if (existsSync(this.profilesPath)) {
      rmSync(this.profilesPath, { force: true });
    }
    return count;
  }

  profilesStatText(): string {
    const profiles = this.loadProfiles();
    if (!profiles.length) return '0 套模型方案';
    const kb = existsSync(this.profilesPath)
      ? Math.max(1, Math.ceil(statSync(this.profilesPath).size / 1024))
      : 0;
    return `${profiles.length} 套模型方案（${kb} KB）`;
  }

  loadSyncState(): PromptSyncState {
    if (!existsSync(this.syncStatePath)) {
      return { lastSeenSignature: '', lastSeenLabel: '', lastAutoSwitch: null };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.syncStatePath, 'utf8'));
      if (!isPlainObject(parsed)) {
        return { lastSeenSignature: '', lastSeenLabel: '', lastAutoSwitch: null };
      }
      return {
        lastSeenSignature: typeof parsed.lastSeenSignature === 'string' ? parsed.lastSeenSignature : '',
        lastSeenLabel: typeof parsed.lastSeenLabel === 'string' ? parsed.lastSeenLabel : '',
        lastAutoSwitch: isPlainObject(parsed.lastAutoSwitch) ? (parsed.lastAutoSwitch as unknown as AutoSwitchRecord) : null,
      };
    } catch {
      return { lastSeenSignature: '', lastSeenLabel: '', lastAutoSwitch: null };
    }
  }

  saveSyncState(state: PromptSyncState): void {
    writeJsonAtomic(this.syncStatePath, {
      version: 1,
      lastSeenSignature: state.lastSeenSignature ?? '',
      lastSeenLabel: state.lastSeenLabel ?? '',
      lastAutoSwitch: state.lastAutoSwitch ?? null,
    });
  }
}

export const PROMPT_EDITOR_TOOL_DECLS = [
  {
    name: 'journey_prompt_read',
    description:
      '读取『大肥鱼环游世界』当前生效的生图提示词配置（imageStyle、imageCast、imageStyleCast）、当前使用的生图模型信息、命中的模型方案、待保存草稿状态以及最近一次备份快照 ID。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    tags: ['read', 'snapshot'] as const,
    summary: {
      zh: '读取当前生效的三项生图提示词、当前生图模型与匹配方案状态。',
      en: 'Read active Journey image prompts, current image model, and matched profile.',
    },
  },
  {
    name: 'journey_prompt_preview',
    description:
      '修改并预览对比『大肥鱼环游世界』生图提示词（仅限 imageStyle、imageCast、imageStyleCast）。省略字段表示保持原值，传空字符串 "" 表示清空。默认将本次修改暂存为草稿（stage=true），便于主人确认后直接调用 journey_prompt_save 保存；不传字段时可查看当前待保存草稿的对比；传 discardDraft=true 可清空草稿。',
    parameters: {
      type: 'object',
      properties: {
        imageStyle: {
          type: 'string',
          description: '默认画风提示词；省略保持原值，传 "" 清空。',
        },
        imageCast: {
          type: 'string',
          description: '出镜角色外貌描述；省略保持原值，传 "" 清空（画面不含出镜角色）。',
        },
        imageStyleCast: {
          type: 'string',
          description: '角色出镜时的专属画风；省略保持原值，传 "" 清空（回退到 imageStyle）。',
        },
        reason: {
          type: 'string',
          description: '本次修改的可选备注说明，保存时会写入备份历史。',
        },
        stage: {
          type: 'boolean',
          description: '是否将修改暂存为待保存草稿，默认 true；传 false 仅预览不改动草稿。',
        },
        mergeWithDraft: {
          type: 'boolean',
          description: '是否在已有草稿基础上增量修改，默认 false（以当前生效配置为基准）。',
        },
        discardDraft: {
          type: 'boolean',
          description: '传 true 时放弃并清空当前待保存草稿。',
        },
      },
      additionalProperties: false,
    },
    tags: ['read', 'write'] as const,
    summary: {
      zh: '修改/暂存生图提示词草稿，并生成修改前后的逐字段预览对比。',
      en: 'Modify/stage Journey image prompt changes and preview before/after diffs.',
    },
  },
  {
    name: 'journey_prompt_save',
    description:
      '保存『大肥鱼环游世界』生图提示词修改到底层配置并立即热更新生效（同时持久化到 config.json），保存前会自动备份旧值供回滚。可直接保存之前用 journey_prompt_preview 暂存的草稿，也可直接传入 imageStyle、imageCast、imageStyleCast 一步修改并保存；支持 syncMatchedProfile=true 同步更新当前生图模型命中的方案。',
    parameters: {
      type: 'object',
      properties: {
        imageStyle: {
          type: 'string',
          description: '直接保存的新默认画风；不传任何提示词字段时默认保存已暂存的草稿。',
        },
        imageCast: {
          type: 'string',
          description: '直接保存的新出镜角色描述；传 "" 表示清空。',
        },
        imageStyleCast: {
          type: 'string',
          description: '直接保存的新出镜专属画风；传 "" 表示清空（回退到 imageStyle）。',
        },
        reason: {
          type: 'string',
          description: '本次保存的变更备注（写入历史备份，方便日后识别回滚）。',
        },
        expectedBaseHash: {
          type: 'string',
          description: '可选防并发校验值（来自 read 或 preview 返回的 baseHash）；若当前配置已被外部改动则拒绝覆盖。',
        },
        force: {
          type: 'boolean',
          description: '当草稿基准与当前配置发生外部漂移时，传 true 强制覆盖保存；默认 false。',
        },
        syncMatchedProfile: {
          type: 'boolean',
          description: '传 true 且当前生图模型命中了某套已保存方案时，同步把新提示词写回该模型方案；默认 false。',
        },
      },
      additionalProperties: false,
    },
    tags: ['write'] as const,
    summary: {
      zh: '保存生图提示词修改并自动备份旧版本，热更新立即生效。',
      en: 'Save image prompt changes with automatic backup and live hot-apply.',
    },
  },
  {
    name: 'journey_prompt_history',
    description:
      '查看『大肥鱼环游世界』生图提示词的历史备份快照列表（含手动保存、方案切换、自动随模型切换与回滚记录），或按 snapshotId 查看某一条备份的完整内容及与当前生效配置的差异。',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: '返回的最近备份条数，默认 10，最多 50。',
        },
        snapshotId: {
          type: 'string',
          description: '可选：指定某条快照 ID，返回该快照的完整三字段内容及与当前配置的对比。',
        },
      },
      additionalProperties: false,
    },
    tags: ['read'] as const,
    summary: {
      zh: '查询生图提示词的备份历史列表或指定快照详情。',
      en: 'List backup snapshots or inspect a specific snapshot in detail.',
    },
  },
  {
    name: 'journey_prompt_rollback',
    description:
      '将『大肥鱼环游世界』生图提示词回滚到历史备份版本。省略 snapshotId 时默认回滚到最近一次修改前的状态；支持 previewOnly=true 先预览回滚对比再执行。正式回滚前会自动把当前配置备份为一条新快照，确保回滚操作本身也可撤销。',
    parameters: {
      type: 'object',
      properties: {
        snapshotId: {
          type: 'string',
          description: '要回滚的目标快照 ID（来自 journey_prompt_history）；省略时默认使用最新一条备份。',
        },
        target: {
          type: 'string',
          enum: ['before', 'after'],
          description: '恢复该快照记录的修改前状态（before，默认）或修改后状态（after）。',
        },
        previewOnly: {
          type: 'boolean',
          description: '传 true 仅预览回滚对比，不写入配置；默认 false。',
        },
        reason: {
          type: 'string',
          description: '可选回滚备注说明。',
        },
      },
      additionalProperties: false,
    },
    tags: ['write'] as const,
    summary: {
      zh: '将生图提示词回滚到指定或上一份备份快照（支持仅预览对比）。',
      en: 'Rollback Journey image prompts to a previous backup snapshot (with preview mode).',
    },
  },
  {
    name: 'journey_prompt_profiles',
    description:
      '查看为不同生图模型保存的提示词方案列表，展示当前『大肥鱼环游世界』正在使用的生图模型及其最佳匹配方案；传入 profileId 时返回该方案的完整提示词内容与当前生效配置的差异对比。',
    parameters: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: '可选：查看指定方案 ID 的完整提示词内容及与当前生效配置的差异。',
        },
      },
      additionalProperties: false,
    },
    tags: ['read', 'snapshot'] as const,
    summary: {
      zh: '列出所有多模型生图提示词方案或查看某套方案详情。',
      en: 'List all per-model image prompt profiles or inspect one in detail.',
    },
  },
  {
    name: 'journey_prompt_profile_save',
    description:
      '新增或更新一套绑定特定生图模型的提示词方案。可以传 bindCurrentModel=true 自动绑定当前生图模型、fromCurrent=true 从当前生效提示词复制三项内容，或直接指定 matchModel/matchPreset/matchProtocol 与三项提示词。开启自动切换后，切换生图模型时会自动套用匹配的方案。',
    parameters: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: '方案唯一 ID（如 kolors、qwen、doubao、comfyui-anime）；新建时省略将自动生成。',
        },
        name: {
          type: 'string',
          description: '方案显示名称（如「Kolors 写实+二次元」「千问水彩风」）。',
        },
        matchModel: {
          type: 'string',
          description: '绑定的模型名匹配规则，支持精确名、子串或通配符 *（如 Kwai-Kolors/Kolors、qwen-image*、doubao-seedream*）；留空不限模型名。',
        },
        matchPreset: {
          type: 'string',
          enum: ['', 'custom', 'doubao', 'openai', 'qwen'],
          description: '绑定的云端预设（doubao / openai / qwen / custom）；留空不限预设。',
        },
        matchProtocol: {
          type: 'string',
          enum: ['', 'openai', 'comfyui'],
          description: '绑定的生图协议（openai 云端 / comfyui 本地）；留空不限协议。',
        },
        matchApi: {
          type: 'string',
          description: '可选：接口地址包含的域名或关键字（如 siliconflow.cn、dashscope.aliyuncs.com）。',
        },
        bindCurrentModel: {
          type: 'boolean',
          description: '传 true 时自动以当前生图模型的协议/预设/模型名作为绑定规则（显式传入的 match* 字段优先覆盖）。',
        },
        fromCurrent: {
          type: 'boolean',
          description: '传 true 时以当前生效的三项提示词作为底稿（显式传入的提示词字段优先覆盖）。',
        },
        imageStyle: {
          type: 'string',
          description: '该方案的默认画风提示词；传 "" 表示清空。',
        },
        imageCast: {
          type: 'string',
          description: '该方案的出镜角色描述；传 "" 表示清空。',
        },
        imageStyleCast: {
          type: 'string',
          description: '该方案的出镜专属画风；传 "" 表示清空（回退到 imageStyle）。',
        },
        note: {
          type: 'string',
          description: '可选方案说明备注。',
        },
        applyNow: {
          type: 'boolean',
          description: '保存方案后是否立即热更新应用到当前『大肥鱼环游世界』配置；默认 false。',
        },
      },
      additionalProperties: false,
    },
    tags: ['write'] as const,
    summary: {
      zh: '新建或更新指定生图模型的提示词方案（支持一键绑定当前模型）。',
      en: 'Create or update a prompt profile bound to a specific image model.',
    },
  },
  {
    name: 'journey_prompt_profile_apply',
    description:
      '将某套已保存的模型提示词方案应用到『大肥鱼环游世界』（省略 profileId 时自动匹配当前生图模型对应的方案）。支持 previewOnly=true 先查看切换前后对比；正式应用时热更新立即生效并自动备份旧值。',
    parameters: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: '要应用的方案 ID；省略时自动按当前生图模型匹配最佳方案。',
        },
        previewOnly: {
          type: 'boolean',
          description: '传 true 仅预览应用后的差异对比，不写入配置；默认 false。',
        },
        reason: {
          type: 'string',
          description: '可选变更备注说明。',
        },
      },
      additionalProperties: false,
    },
    tags: ['write'] as const,
    summary: {
      zh: '应用指定或当前模型匹配的提示词方案（支持先预览对比）。',
      en: 'Apply a saved prompt profile (or auto-match current model) with optional preview.',
    },
  },
  {
    name: 'journey_prompt_profile_delete',
    description:
      '删除一套已保存的模型提示词方案（仅删除方案条目，不影响当前生效的生图提示词和历史备份快照）。',
    parameters: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: '要删除的方案 ID。',
        },
      },
      required: ['profileId'],
      additionalProperties: false,
    },
    tags: ['write'] as const,
    summary: {
      zh: '删除指定 ID 的模型提示词方案。',
      en: 'Delete a saved per-model prompt profile by ID.',
    },
  },
] as const;

function assertOptionalBoolean(args: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(args, key) && args[key] !== undefined && typeof args[key] !== 'boolean') {
    throw new TypeError(`${key} 必须是布尔值`);
  }
}

function assertOptionalString(args: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(args, key) && args[key] !== undefined && typeof args[key] !== 'string') {
    throw new TypeError(`${key} 必须是字符串`);
  }
}

export function createPromptEditorService(deps: {
  bridge: PromptBridge;
  store: PromptEditorStore;
  getConfig?: () => { promptAutoSwitch?: boolean };
  onAfterWrite?: (backend: ImageBackendMeta) => void;
}) {
  const { bridge, store, getConfig = () => ({}), onAfterWrite } = deps;
  let checking = false;

  function isAutoSwitchEnabled(): boolean {
    return getConfig()?.promptAutoSwitch !== false;
  }

  function recordSeenBackend(backend: ImageBackendMeta): void {
    const prev = store.loadSyncState();
    store.saveSyncState({
      lastSeenSignature: backend.signature,
      lastSeenLabel: backend.displayLabel,
      lastAutoSwitch: prev.lastAutoSwitch,
    });
  }

  function buildMatchedInfo(
    profiles: readonly StoredPromptProfile[],
    backend: ImageBackendMeta,
    currentFields: PromptFields,
  ) {
    const matched = matchProfileForBackend(profiles, backend);
    if (!matched) return null;
    const diff = buildPromptDiff(currentFields, matched.profile.fields);
    return {
      profileId: matched.profile.id,
      name: matched.profile.name,
      score: matched.score,
      matchDescription: describeMatchRule(matched.profile.match),
      inSync: !diff.hasChanges,
      diffFields: diff.changedFields,
    };
  }

  async function readState() {
    const current = await bridge.readPrompts();
    const baseHash = computeFieldsHash(current.fields);
    const draft = store.loadDraft();
    const history = store.loadHistory();
    const profiles = store.loadProfiles();
    const syncState = store.loadSyncState();
    const latest = history[0] ?? null;

    const draftInfo = draft
      ? {
          exists: true,
          updatedAt: draft.updatedAt,
          reason: draft.reason || undefined,
          changedFields: Object.keys(draft.patch),
          baseDrifted: Boolean(draft.baseHash && draft.baseHash !== baseHash),
        }
      : { exists: false };

    return {
      author: PROMPT_EDITOR_AUTHOR,
      source: current.source,
      liveConnected: current.liveConnected,
      ...(current.webUrl ? { webUrl: current.webUrl } : {}),
      ...(current.rpcError ? { rpcNotice: current.rpcError } : {}),
      baseHash,
      activeBackend: current.backend,
      matchedProfile: buildMatchedInfo(profiles, current.backend, current.fields),
      autoSwitchByModel: isAutoSwitchEnabled(),
      ...(syncState.lastAutoSwitch ? { lastAutoSwitch: syncState.lastAutoSwitch } : {}),
      fields: current.fields,
      effectiveStyleNote: effectiveCastStyleNote(current.fields),
      draft: draftInfo,
      profileCount: profiles.length,
      historyCount: history.length,
      latestSnapshotId: latest?.id ?? null,
    };
  }

  async function previewChanges(args: Record<string, unknown> = {}) {
    assertOptionalString(args, 'reason');
    assertOptionalBoolean(args, 'stage');
    assertOptionalBoolean(args, 'mergeWithDraft');
    assertOptionalBoolean(args, 'discardDraft');

    const incomingPatch = extractPromptPatch(args, { allowEmpty: true });
    const hasIncomingFields = Object.keys(incomingPatch).length > 0;

    if (args.discardDraft === true) {
      if (hasIncomingFields) {
        throw new TypeError('discardDraft=true 时不能同时传入提示词字段');
      }
      const cleared = store.clearDraft();
      return {
        discarded: cleared,
        message: cleared ? '已清空待保存草稿。' : '当前没有待保存草稿。',
      };
    }

    const current = await bridge.readPrompts();
    const baseHash = computeFieldsHash(current.fields);
    const existingDraft = store.loadDraft();
    const shouldStage = args.stage !== false;

    if (!hasIncomingFields) {
      if (!existingDraft) {
        return {
          source: current.source,
          liveConnected: current.liveConnected,
          activeBackend: current.backend,
          baseHash,
          hasDraft: false,
          hasChanges: false,
          fields: current.fields,
          changes: [],
          diffMarkdown: '当前没有待保存草稿，且未传入任何修改字段。',
        };
      }
      const proposed = applyPromptPatch(current.fields, existingDraft.patch);
      const diff = buildPromptDiff(current.fields, proposed);
      return {
        source: current.source,
        liveConnected: current.liveConnected,
        activeBackend: current.backend,
        baseHash,
        hasDraft: true,
        staged: true,
        draftUpdatedAt: existingDraft.updatedAt,
        draftBaseDrifted: Boolean(existingDraft.baseHash && existingDraft.baseHash !== baseHash),
        ...(existingDraft.reason ? { reason: existingDraft.reason } : {}),
        hasChanges: diff.hasChanges,
        changedFields: diff.changedFields,
        changes: diff.changes,
        before: current.fields,
        after: proposed,
        effectiveStyleNote: effectiveCastStyleNote(proposed),
        diffMarkdown: diff.diffMarkdown,
      };
    }

    const baseForMerge = args.mergeWithDraft === true && existingDraft
      ? applyPromptPatch(current.fields, existingDraft.patch)
      : current.fields;
    const proposed = applyPromptPatch(baseForMerge, incomingPatch);
    const diff = buildPromptDiff(current.fields, proposed);

    const effectivePatch: Partial<PromptFields> = {};
    for (const field of PROMPT_FIELDS) {
      if (proposed[field] !== current.fields[field]) {
        effectivePatch[field] = proposed[field];
      }
    }

    let staged = false;
    const reasonText = typeof args.reason === 'string'
      ? args.reason.trim()
      : (args.mergeWithDraft === true && existingDraft?.reason ? existingDraft.reason : '');

    if (shouldStage) {
      if (diff.hasChanges) {
        store.saveDraft({
          baseHash,
          patch: effectivePatch,
          reason: reasonText,
        });
        staged = true;
      } else {
        store.clearDraft();
      }
    }

    return {
      source: current.source,
      liveConnected: current.liveConnected,
      activeBackend: current.backend,
      baseHash,
      staged,
      ...(reasonText ? { reason: reasonText } : {}),
      hasChanges: diff.hasChanges,
      changedFields: diff.changedFields,
      changes: diff.changes,
      before: current.fields,
      after: proposed,
      effectiveStyleNote: effectiveCastStyleNote(proposed),
      diffMarkdown: diff.diffMarkdown,
      nextStep: diff.hasChanges
        ? (staged ? '修改已暂存为草稿；确认无误后可直接调用 journey_prompt_save 保存生效。' : '当前为纯预览模式（未暂存草稿）；如需保存请调用 journey_prompt_save 并传入字段。')
        : '修改后与当前配置一致，无需保存。',
    };
  }

  async function saveChanges(args: Record<string, unknown> = {}) {
    assertOptionalString(args, 'reason');
    assertOptionalString(args, 'expectedBaseHash');
    assertOptionalBoolean(args, 'force');
    assertOptionalBoolean(args, 'syncMatchedProfile');

    const directPatch = extractPromptPatch(args, { allowEmpty: true });
    const hasDirectPatch = Object.keys(directPatch).length > 0;
    const draft = store.loadDraft();

    if (!hasDirectPatch && !draft) {
      throw new Error('没有可保存的内容：请先调用 journey_prompt_preview 暂存修改，或在 journey_prompt_save 中直接传入要修改的字段。');
    }

    const current = await bridge.readPrompts();
    const currentHash = computeFieldsHash(current.fields);

    if (typeof args.expectedBaseHash === 'string' && args.expectedBaseHash && args.expectedBaseHash !== currentHash) {
      throw new Error(
        `保存已中止：当前生图提示词配置已发生变化（期望基准 ${args.expectedBaseHash}，当前为 ${currentHash}）。请先重新读取并预览对比后再保存。`,
      );
    }

    if (!hasDirectPatch && draft?.baseHash && draft.baseHash !== currentHash && args.force !== true) {
      throw new Error(
        `保存已中止：自上次预览暂存草稿后，底层配置已被外部改动（草稿基准 ${draft.baseHash}，当前为 ${currentHash}）。请先调用 journey_prompt_preview 重新对比确认，或传 force=true 强制覆盖。`,
      );
    }

    const activePatch = hasDirectPatch ? directPatch : (draft?.patch ?? {});
    const proposed = applyPromptPatch(current.fields, activePatch);
    const diff = buildPromptDiff(current.fields, proposed);

    if (!diff.hasChanges) {
      store.clearDraft();
      return {
        saved: false,
        unchanged: true,
        source: current.source,
        liveApplied: false,
        activeBackend: current.backend,
        fields: current.fields,
        message: '目标内容与当前生效配置完全一致，未执行写入，也未新增备份。',
      };
    }

    const writePatch: Partial<PromptFields> = {};
    for (const field of diff.changedFields) {
      writePatch[field] = proposed[field];
    }

    const writeResult = await bridge.writePrompts(writePatch);
    const finalDiff = buildPromptDiff(current.fields, writeResult.fields);
    const reasonText = typeof args.reason === 'string' && args.reason.trim()
      ? args.reason.trim()
      : (!hasDirectPatch && draft?.reason ? draft.reason : '');

    const snapshot = store.appendSnapshot({
      action: 'save',
      reason: reasonText,
      applyMode: writeResult.applyMode,
      modelLabel: writeResult.backend.displayLabel,
      changedFields: finalDiff.changedFields,
      before: current.fields,
      after: writeResult.fields,
    });
    store.clearDraft();

    let syncedProfileId: string | null = null;
    if (args.syncMatchedProfile === true) {
      const matched = matchProfileForBackend(store.loadProfiles(), writeResult.backend);
      if (matched) {
        store.upsertProfile({
          id: matched.profile.id,
          name: matched.profile.name,
          match: matched.profile.match,
          fields: writeResult.fields,
          note: matched.profile.note,
        });
        syncedProfileId = matched.profile.id;
      }
    }

    recordSeenBackend(writeResult.backend);
    onAfterWrite?.(writeResult.backend);

    return {
      saved: true,
      snapshotId: snapshot.id,
      createdAt: snapshot.createdAt,
      applyMode: writeResult.applyMode,
      liveApplied: writeResult.liveApplied,
      activeBackend: writeResult.backend,
      ...(syncedProfileId ? { syncedProfileId } : {}),
      note: writeResult.liveApplied
        ? '已实时写入『大肥鱼环游世界』并保存到 config.json，下一张生图立即生效。'
        : '已写入 config.json，重启生效。',
      ...(reasonText ? { reason: reasonText } : {}),
      changedFields: finalDiff.changedFields,
      changes: finalDiff.changes,
      fields: writeResult.fields,
      baseHash: computeFieldsHash(writeResult.fields),
      effectiveStyleNote: effectiveCastStyleNote(writeResult.fields),
      diffMarkdown: finalDiff.diffMarkdown,
    };
  }

  async function readHistory(args: Record<string, unknown> = {}) {
    if (Object.hasOwn(args, 'limit') && args.limit !== undefined) {
      if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50) {
        throw new TypeError('limit 必须是 1 到 50 之间的整数');
      }
    }
    assertOptionalString(args, 'snapshotId');

    const history = store.loadHistory();
    if (typeof args.snapshotId === 'string' && args.snapshotId) {
      const target = history.find((item) => item.id === args.snapshotId);
      if (!target) {
        throw new Error(`未找到快照：${args.snapshotId}`);
      }
      const current = await bridge.readPrompts();
      const diffToBefore = buildPromptDiff(current.fields, target.before);
      const diffToAfter = buildPromptDiff(current.fields, target.after);
      return {
        snapshot: target,
        currentFields: current.fields,
        rollbackToBeforeDiff: {
          hasChanges: diffToBefore.hasChanges,
          changedFields: diffToBefore.changedFields,
          diffMarkdown: diffToBefore.diffMarkdown,
        },
        rollbackToAfterDiff: {
          hasChanges: diffToAfter.hasChanges,
          changedFields: diffToAfter.changedFields,
          diffMarkdown: diffToAfter.diffMarkdown,
        },
      };
    }

    const limit = typeof args.limit === 'number' ? args.limit : 10;
    const entries = history.slice(0, limit).map((item) => ({
      snapshotId: item.id,
      createdAt: item.createdAt,
      action: item.action,
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.profileId ? { profileId: item.profileId } : {}),
      ...(item.modelLabel ? { modelLabel: item.modelLabel } : {}),
      ...(item.restoredFrom ? { restoredFrom: item.restoredFrom } : {}),
      applyMode: item.applyMode,
      changedFields: item.changedFields,
      beforeSummary: {
        imageStyle: summarizeText(item.before.imageStyle),
        imageCast: summarizeText(item.before.imageCast),
        imageStyleCast: summarizeText(item.before.imageStyleCast),
      },
      afterSummary: {
        imageStyle: summarizeText(item.after.imageStyle),
        imageCast: summarizeText(item.after.imageCast),
        imageStyleCast: summarizeText(item.after.imageStyleCast),
      },
    }));

    return {
      total: history.length,
      showing: entries.length,
      snapshots: entries,
    };
  }

  async function rollbackPrompt(args: Record<string, unknown> = {}) {
    assertOptionalString(args, 'snapshotId');
    assertOptionalString(args, 'target');
    assertOptionalBoolean(args, 'previewOnly');
    assertOptionalString(args, 'reason');

    const targetSide = (typeof args.target === 'string' ? args.target : 'before') as 'before' | 'after';
    if (targetSide !== 'before' && targetSide !== 'after') {
      throw new TypeError('target 只能是 before 或 after');
    }

    const snapshot = store.getSnapshot(typeof args.snapshotId === 'string' ? args.snapshotId : undefined);
    if (!snapshot) {
      throw new Error(
        args.snapshotId
          ? `未找到可回滚的备份快照：${String(args.snapshotId)}`
          : '暂无历史备份快照，无法回滚。',
      );
    }

    const current = await bridge.readPrompts();
    const desired = targetSide === 'after' ? snapshot.after : snapshot.before;
    const diff = buildPromptDiff(current.fields, desired);

    if (args.previewOnly === true) {
      return {
        previewOnly: true,
        targetSnapshotId: snapshot.id,
        targetSide,
        snapshotCreatedAt: snapshot.createdAt,
        hasChanges: diff.hasChanges,
        changedFields: diff.changedFields,
        changes: diff.changes,
        before: current.fields,
        after: desired,
        effectiveStyleNote: effectiveCastStyleNote(desired),
        diffMarkdown: diff.diffMarkdown,
      };
    }

    if (!diff.hasChanges) {
      return {
        rolledBack: false,
        unchanged: true,
        targetSnapshotId: snapshot.id,
        targetSide,
        fields: current.fields,
        message: '当前生效配置已经与目标备份版本一致，无需回滚。',
      };
    }

    const writePatch: Partial<PromptFields> = {};
    for (const field of diff.changedFields) {
      writePatch[field] = desired[field];
    }

    const writeResult = await bridge.writePrompts(writePatch);
    const finalDiff = buildPromptDiff(current.fields, writeResult.fields);
    const reasonText = typeof args.reason === 'string' && args.reason.trim()
      ? args.reason.trim()
      : `回滚到 ${snapshot.id}（${targetSide === 'after' ? '修改后' : '修改前'}）`;

    const backupSnapshot = store.appendSnapshot({
      action: 'rollback',
      reason: reasonText,
      applyMode: writeResult.applyMode,
      restoredFrom: `${snapshot.id}:${targetSide}`,
      modelLabel: writeResult.backend.displayLabel,
      changedFields: finalDiff.changedFields,
      before: current.fields,
      after: writeResult.fields,
    });
    store.clearDraft();
    recordSeenBackend(writeResult.backend);
    onAfterWrite?.(writeResult.backend);

    return {
      rolledBack: true,
      restoredFromSnapshotId: snapshot.id,
      targetSide,
      newBackupSnapshotId: backupSnapshot.id,
      createdAt: backupSnapshot.createdAt,
      applyMode: writeResult.applyMode,
      liveApplied: writeResult.liveApplied,
      note: writeResult.liveApplied
        ? '已完成回滚并实时热更新生效，回滚前的状态已自动备份为新快照。'
        : '已写入 config.json，重启生效。',
      changedFields: finalDiff.changedFields,
      changes: finalDiff.changes,
      fields: writeResult.fields,
      baseHash: computeFieldsHash(writeResult.fields),
      effectiveStyleNote: effectiveCastStyleNote(writeResult.fields),
      diffMarkdown: finalDiff.diffMarkdown,
    };
  }

  async function listProfiles(args: Record<string, unknown> = {}) {
    assertOptionalString(args, 'profileId');

    const current = await bridge.readPrompts();
    const profiles = store.loadProfiles();
    const best = matchProfileForBackend(profiles, current.backend);

    if (typeof args.profileId === 'string' && args.profileId) {
      const target = profiles.find((p) => p.id === args.profileId);
      if (!target) {
        throw new Error(`未找到模型提示词方案：${args.profileId}`);
      }
      const diff = buildPromptDiff(current.fields, target.fields);
      const score = scoreProfileForBackend(target, current.backend);
      return {
        activeBackend: current.backend,
        profile: {
          ...target,
          matchDescription: describeMatchRule(target.match),
          matchesCurrentBackend: score !== null,
          isBestMatch: best?.profile.id === target.id,
          inSyncWithActive: !diff.hasChanges,
        },
        diffAgainstActive: {
          hasChanges: diff.hasChanges,
          changedFields: diff.changedFields,
          changes: diff.changes,
          diffMarkdown: diff.diffMarkdown,
        },
      };
    }

    return {
      author: PROMPT_EDITOR_AUTHOR,
      activeBackend: current.backend,
      autoSwitchByModel: isAutoSwitchEnabled(),
      matchedProfile: buildMatchedInfo(profiles, current.backend, current.fields),
      total: profiles.length,
      profiles: profiles.map((p) => {
        const score = scoreProfileForBackend(p, current.backend);
        const diff = buildPromptDiff(current.fields, p.fields);
        return {
          profileId: p.id,
          name: p.name,
          match: p.match,
          matchDescription: describeMatchRule(p.match),
          autoMatchEnabled: hasMatchCriteria(p.match),
          matchesCurrentBackend: score !== null,
          isBestMatch: best?.profile.id === p.id,
          inSyncWithActive: !diff.hasChanges,
          diffFields: diff.changedFields,
          note: p.note || undefined,
          updatedAt: p.updatedAt,
          fields: p.fields,
          fieldsSummary: {
            imageStyle: summarizeText(p.fields.imageStyle),
            imageCast: summarizeText(p.fields.imageCast),
            imageStyleCast: summarizeText(p.fields.imageStyleCast),
          },
        };
      }),
    };
  }

  async function saveProfile(args: Record<string, unknown> = {}) {
    assertOptionalString(args, 'profileId');
    assertOptionalString(args, 'name');
    assertOptionalString(args, 'matchModel');
    assertOptionalString(args, 'matchPreset');
    assertOptionalString(args, 'matchProtocol');
    assertOptionalString(args, 'matchApi');
    assertOptionalString(args, 'note');
    assertOptionalBoolean(args, 'bindCurrentModel');
    assertOptionalBoolean(args, 'fromCurrent');
    assertOptionalBoolean(args, 'applyNow');

    const incomingFields = extractPromptPatch(args, { allowEmpty: true });
    const hasIncomingFields = Object.keys(incomingFields).length > 0;
    const current = await bridge.readPrompts();

    const rawId = typeof args.profileId === 'string' ? args.profileId.trim() : '';
    const existing = rawId ? store.getProfile(rawId) : null;

    if (!existing && !hasIncomingFields && args.fromCurrent !== true) {
      throw new TypeError('新建方案时，请至少提供 imageStyle/imageCast/imageStyleCast 之一，或传 fromCurrent=true 复制当前配置');
    }

    const baseMatch = args.bindCurrentModel === true
      ? buildMatchRuleFromBackend(current.backend)
      : (existing?.match ?? { model: '', preset: '', protocol: '', api: '' });

    const mergedMatch = normalizeMatchRule({
      model: Object.hasOwn(args, 'matchModel') && args.matchModel !== undefined ? args.matchModel : baseMatch.model,
      preset: Object.hasOwn(args, 'matchPreset') && args.matchPreset !== undefined ? args.matchPreset : baseMatch.preset,
      protocol: Object.hasOwn(args, 'matchProtocol') && args.matchProtocol !== undefined ? args.matchProtocol : baseMatch.protocol,
      api: Object.hasOwn(args, 'matchApi') && args.matchApi !== undefined ? args.matchApi : baseMatch.api,
    });

    const baseFields = args.fromCurrent === true
      ? current.fields
      : (existing?.fields ?? { imageStyle: '', imageCast: '', imageStyleCast: '' });
    const finalFields = applyPromptPatch(baseFields, incomingFields);

    const displayName = (typeof args.name === 'string' && args.name.trim())
      ? args.name.trim()
      : (existing?.name || mergedMatch.model || mergedMatch.preset || mergedMatch.protocol || current.backend.displayLabel);

    const profileId = rawId
      ? validateProfileId(rawId)
      : slugifyProfileId(mergedMatch.model || mergedMatch.preset || displayName || 'model');

    const noteText = Object.hasOwn(args, 'note') && typeof args.note === 'string'
      ? args.note.trim()
      : (existing?.note ?? '');

    const { profile, created } = store.upsertProfile({
      id: profileId,
      name: displayName,
      match: mergedMatch,
      fields: finalFields,
      note: noteText,
    });

    let applyResult: Record<string, unknown> | null = null;
    if (args.applyNow === true) {
      applyResult = await applyProfile({
        profileId: profile.id,
        reason: `保存并应用方案「${profile.name}」`,
      });
    }

    return {
      saved: true,
      created,
      profileId: profile.id,
      profile: {
        ...profile,
        matchDescription: describeMatchRule(profile.match),
      },
      activeBackend: current.backend,
      matchesCurrentBackend: scoreProfileForBackend(profile, current.backend) !== null,
      ...(applyResult ? { applyResult } : {}),
    };
  }

  async function applyProfile(args: Record<string, unknown> = {}) {
    assertOptionalString(args, 'profileId');
    assertOptionalBoolean(args, 'previewOnly');
    assertOptionalString(args, 'reason');

    const current = await bridge.readPrompts();
    const profiles = store.loadProfiles();

    let target: StoredPromptProfile | undefined;
    let matchedAutomatically = false;

    if (typeof args.profileId === 'string' && args.profileId.trim()) {
      const id = args.profileId.trim();
      target = profiles.find((p) => p.id === id);
      if (!target) {
        throw new Error(`未找到模型提示词方案：${id}`);
      }
    } else {
      const matched = matchProfileForBackend(profiles, current.backend);
      if (!matched) {
        throw new Error(
          `当前生图模型「${current.backend.displayLabel}」没有匹配到已保存的提示词方案。请先用 journey_prompt_profile_save 创建绑定方案，或显式传入 profileId。`,
        );
      }
      target = matched.profile;
      matchedAutomatically = true;
    }

    const diff = buildPromptDiff(current.fields, target.fields);

    if (args.previewOnly === true) {
      return {
        previewOnly: true,
        profileId: target.id,
        profileName: target.name,
        matchedAutomatically,
        activeBackend: current.backend,
        hasChanges: diff.hasChanges,
        changedFields: diff.changedFields,
        changes: diff.changes,
        before: current.fields,
        after: target.fields,
        effectiveStyleNote: effectiveCastStyleNote(target.fields),
        diffMarkdown: diff.diffMarkdown,
      };
    }

    if (!diff.hasChanges) {
      return {
        applied: false,
        unchanged: true,
        profileId: target.id,
        profileName: target.name,
        matchedAutomatically,
        activeBackend: current.backend,
        fields: current.fields,
        message: `当前生效提示词已经与方案「${target.name}」一致，无需重复写入。`,
      };
    }

    const writePatch: Partial<PromptFields> = {};
    for (const field of diff.changedFields) {
      writePatch[field] = target.fields[field];
    }

    const writeResult = await bridge.writePrompts(writePatch);
    const finalDiff = buildPromptDiff(current.fields, writeResult.fields);
    const reasonText = typeof args.reason === 'string' && args.reason.trim()
      ? args.reason.trim()
      : `应用模型方案「${target.name}」（当前模型：${writeResult.backend.displayLabel}）`;

    const snapshot = store.appendSnapshot({
      action: 'profile-apply',
      reason: reasonText,
      applyMode: writeResult.applyMode,
      profileId: target.id,
      modelLabel: writeResult.backend.displayLabel,
      changedFields: finalDiff.changedFields,
      before: current.fields,
      after: writeResult.fields,
    });
    store.clearDraft();
    recordSeenBackend(writeResult.backend);
    onAfterWrite?.(writeResult.backend);

    return {
      applied: true,
      profileId: target.id,
      profileName: target.name,
      matchedAutomatically,
      snapshotId: snapshot.id,
      createdAt: snapshot.createdAt,
      applyMode: writeResult.applyMode,
      liveApplied: writeResult.liveApplied,
      activeBackend: writeResult.backend,
      note: writeResult.liveApplied
        ? `已将方案「${target.name}」热更新应用到『大肥鱼环游世界』并保存到 config.json，下一张生图立即生效。`
        : `已将方案「${target.name}」写入 config.json，重启后生效。`,
      changedFields: finalDiff.changedFields,
      changes: finalDiff.changes,
      fields: writeResult.fields,
      baseHash: computeFieldsHash(writeResult.fields),
      effectiveStyleNote: effectiveCastStyleNote(writeResult.fields),
      diffMarkdown: finalDiff.diffMarkdown,
    };
  }

  async function deleteProfile(args: Record<string, unknown> = {}) {
    assertOptionalString(args, 'profileId');
    const id = typeof args.profileId === 'string' ? args.profileId.trim() : '';
    if (!id) throw new TypeError('profileId 不能为空');
    const deleted = store.deleteProfile(id);
    if (!deleted) {
      throw new Error(`未找到要删除的模型提示词方案：${id}`);
    }
    return {
      deleted: true,
      profileId: deleted.id,
      name: deleted.name,
      remainingCount: store.loadProfiles().length,
    };
  }

  /**
   * 检测当前生图模型签名是否变化；变化且启用了自动切换时自动套用最佳方案并备份旧值。
   * 同一模型下手动微调提示词不会触发覆盖。
   */
  async function checkModelSwitch(trigger = 'manual') {
    if (checking) return { status: 'busy' as const };
    checking = true;
    try {
      const current = await bridge.readPrompts();
      const backend = current.backend;
      const syncState = store.loadSyncState();
      const prevSig = syncState.lastSeenSignature;
      const prevLabel = syncState.lastSeenLabel;

      if (!prevSig) {
        store.saveSyncState({
          lastSeenSignature: backend.signature,
          lastSeenLabel: backend.displayLabel,
          lastAutoSwitch: syncState.lastAutoSwitch,
        });
        return { status: 'initialized' as const, backend };
      }

      if (prevSig === backend.signature) {
        return { status: 'unchanged' as const, backend };
      }

      store.saveSyncState({
        lastSeenSignature: backend.signature,
        lastSeenLabel: backend.displayLabel,
        lastAutoSwitch: syncState.lastAutoSwitch,
      });

      if (!isAutoSwitchEnabled()) {
        return { status: 'disabled' as const, previousLabel: prevLabel, backend };
      }

      const profiles = store.loadProfiles();
      const matched = matchProfileForBackend(profiles, backend);
      if (!matched) {
        return { status: 'no-match' as const, previousLabel: prevLabel, backend };
      }

      const diff = buildPromptDiff(current.fields, matched.profile.fields);
      if (!diff.hasChanges) {
        return {
          status: 'already-synced' as const,
          profileId: matched.profile.id,
          profileName: matched.profile.name,
          backend,
        };
      }

      const patch: Partial<PromptFields> = {};
      for (const field of diff.changedFields) {
        patch[field] = matched.profile.fields[field];
      }

      const writeResult = await bridge.writePrompts(patch);
      const finalDiff = buildPromptDiff(current.fields, writeResult.fields);
      const reason = `检测到生图模型切换（${prevLabel || prevSig} → ${backend.displayLabel}），自动应用方案「${matched.profile.name}」`;

      const snapshot = store.appendSnapshot({
        action: 'auto-switch',
        reason,
        applyMode: writeResult.applyMode,
        profileId: matched.profile.id,
        modelLabel: backend.displayLabel,
        changedFields: finalDiff.changedFields,
        before: current.fields,
        after: writeResult.fields,
      });
      store.clearDraft();

      const autoSwitchRecord: AutoSwitchRecord = {
        at: snapshot.createdAt,
        trigger,
        fromModel: prevLabel || prevSig,
        toModel: backend.displayLabel,
        profileId: matched.profile.id,
        profileName: matched.profile.name,
        snapshotId: snapshot.id,
        liveApplied: writeResult.liveApplied,
      };
      store.saveSyncState({
        lastSeenSignature: backend.signature,
        lastSeenLabel: backend.displayLabel,
        lastAutoSwitch: autoSwitchRecord,
      });

      return {
        status: 'switched' as const,
        ...autoSwitchRecord,
        changedFields: finalDiff.changedFields,
      };
    } finally {
      checking = false;
    }
  }

  return {
    readState,
    previewChanges,
    saveChanges,
    readHistory,
    rollbackPrompt,
    listProfiles,
    saveProfile,
    applyProfile,
    deleteProfile,
    checkModelSwitch,
  };
}

export type PromptEditorService = ReturnType<typeof createPromptEditorService>;

function okJson(payload: unknown) {
  return { text: JSON.stringify(payload, null, 2) };
}

function failText(message: string) {
  return { isError: true, text: message };
}

function makeTool(
  declaration: (typeof PROMPT_EDITOR_TOOL_DECLS)[number],
  handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>,
): ToolDef {
  return {
    name: declaration.name,
    description: declaration.description,
    parameters: declaration.parameters as unknown as ToolDef['parameters'],
    tags: [...declaration.tags],
    handler: async (args: unknown) => {
      try {
        const safeArgs = args === undefined ? {} : args;
        const props = Object.keys(declaration.parameters.properties);
        assertAllowedKeys(safeArgs, props);
        return await handler(safeArgs as Record<string, unknown>);
      } catch (error) {
        return failText(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function createPromptEditorTools(service: PromptEditorService): ToolDef[] {
  const [
    readDecl,
    previewDecl,
    saveDecl,
    historyDecl,
    rollbackDecl,
    profilesDecl,
    profileSaveDecl,
    profileApplyDecl,
    profileDeleteDecl,
  ] = PROMPT_EDITOR_TOOL_DECLS;

  return [
    makeTool(readDecl, async () => okJson(await service.readState())),
    makeTool(previewDecl, async (args) => okJson(await service.previewChanges(args))),
    makeTool(saveDecl, async (args) => okJson(await service.saveChanges(args))),
    makeTool(historyDecl, async (args) => okJson(await service.readHistory(args))),
    makeTool(rollbackDecl, async (args) => okJson(await service.rollbackPrompt(args))),
    makeTool(profilesDecl, async (args) => okJson(await service.listProfiles(args))),
    makeTool(profileSaveDecl, async (args) => okJson(await service.saveProfile(args))),
    makeTool(profileApplyDecl, async (args) => okJson(await service.applyProfile(args))),
    makeTool(profileDeleteDecl, async (args) => okJson(await service.deleteProfile(args))),
  ];
}
