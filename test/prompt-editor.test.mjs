/**
 * 整合自 frost77r (`cortico-world-journey-prompt-editor` v1.1.0) 的生图提示词管理测试：
 * 1) 9 个工具（读取/预览草稿/保存备份/历史查询/回滚 before & after/多模型方案增删改查应用）
 * 2) 白名单保护（只碰 imageStyle / imageCast / imageStyleCast，绝不碰密钥和其它配置）
 * 3) 切换生图模型时自动匹配方案并先备份旧提示词；同模型下手动微调不覆盖
 * 4) webUi().prompts 面板 RPC 与原生存储项
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');

function mkDir() {
  return mkdtempSync(join(tmpdir(), 'journey-pe-'));
}

function makeHost() {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, cursor: 1, blobs: [] }),
    store: {},
    drainPendingEvents: async () => [],
  };
}

function parseJsonResult(res) {
  assert.equal(Boolean(res.isError), false, `工具不应失败：${res.text}`);
  return JSON.parse(res.text);
}

test('提示词管理：preview 暂存草稿、save 热更新与防并发校验、rollback before/after', async () => {
  const dir = mkDir();
  try {
    const cfg = {
      ...JOURNEY_DEFAULTS(),
      enabled: true,
      imageProtocol: 'openai',
      imagePreset: 'doubao',
      imageModel: 'doubao-seedream-5-0-260128',
      imageStyle: 'initial-style',
      imageCast: '',
      imageStyleCast: '',
    };
    const world = new JourneyWorld({
      cfg,
      dataDir: dir,
      botName: '大肥鱼',
      persist: (patch) => Object.assign(cfg, patch),
    });
    await world.start(makeHost());

    const tool = (name) => world.tools().find((t) => t.name === name);
    for (const name of [
      'journey_prompt_read',
      'journey_prompt_preview',
      'journey_prompt_save',
      'journey_prompt_history',
      'journey_prompt_rollback',
      'journey_prompt_profiles',
      'journey_prompt_profile_save',
      'journey_prompt_profile_apply',
      'journey_prompt_profile_delete',
    ]) {
      assert.ok(tool(name), `缺少工具 ${name}`);
    }

    const r1 = parseJsonResult(await tool('journey_prompt_read').handler({}));
    assert.equal(r1.author, 'frost77r');
    assert.equal(r1.fields.imageStyle, 'initial-style');
    assert.equal(r1.activeBackend.effectiveModel, 'doubao-seedream-5-0-260128');

    // 预览暂存草稿
    const p1 = parseJsonResult(await tool('journey_prompt_preview').handler({
      imageStyle: 'film photography, golden hour',
      imageCast: 'blue haired girl in sweater',
      reason: '试写胶片+人像',
    }));
    assert.equal(p1.staged, true);
    assert.equal(p1.hasChanges, true);
    assert.deepEqual(p1.changedFields, ['imageStyle', 'imageCast']);

    // 错误 baseHash 必须拒绝保存
    const badSave = await tool('journey_prompt_save').handler({ expectedBaseHash: '0000000000000000' });
    assert.equal(badSave.isError, true);
    assert.match(badSave.text, /发生变化/);

    // 正常保存草稿（即时热更新到 cfg + 生成 snap1）
    const s1 = parseJsonResult(await tool('journey_prompt_save').handler({}));
    assert.equal(s1.saved, true);
    assert.equal(s1.liveApplied, true);
    assert.equal(cfg.imageStyle, 'film photography, golden hour');
    assert.equal(cfg.imageCast, 'blue haired girl in sweater');

    // 查历史与回滚到修改前
    const hist = parseJsonResult(await tool('journey_prompt_history').handler({}));
    assert.equal(hist.total, 1);
    const snapId = hist.snapshots[0].snapshotId;

    const rbPreview = parseJsonResult(await tool('journey_prompt_rollback').handler({ snapshotId: snapId, previewOnly: true }));
    assert.equal(rbPreview.previewOnly, true);
    assert.equal(rbPreview.after.imageStyle, 'initial-style');

    const rbRes = parseJsonResult(await tool('journey_prompt_rollback').handler({ snapshotId: snapId, target: 'before' }));
    assert.equal(rbRes.rolledBack, true);
    assert.equal(cfg.imageStyle, 'initial-style');
    assert.equal(cfg.imageCast, '');

    // 历史又多一条回滚备份，可再恢复到修改后
    const rbAfter = parseJsonResult(await tool('journey_prompt_rollback').handler({ snapshotId: snapId, target: 'after' }));
    assert.equal(rbAfter.rolledBack, true);
    assert.equal(cfg.imageStyle, 'film photography, golden hour');

    await world.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('多模型提示词方案：切模型自动热切换+备份，同模型微调不被覆盖，panels.prompts RPC 正常', async () => {
  const dir = mkDir();
  try {
    const cfg = {
      ...JOURNEY_DEFAULTS(),
      enabled: true,
      imageProtocol: 'openai',
      imagePreset: 'qwen',
      imageModel: 'qwen-image-3.0-pro',
      imageStyle: 'qwen watercolor',
      imageCast: 'whale girl',
      imageStyleCast: 'anime cel',
    };
    const world = new JourneyWorld({
      cfg,
      dataDir: dir,
      botName: '大肥鱼',
      persist: (patch) => Object.assign(cfg, patch),
    });
    await world.start(makeHost());

    const tool = (name) => world.tools().find((t) => t.name === name);

    // 存两套方案：qwen 与 doubao
    parseJsonResult(await tool('journey_prompt_profile_save').handler({
      profileId: 'qwen-default',
      name: '千问水彩方案',
      bindCurrentModel: true,
      fromCurrent: true,
    }));
    parseJsonResult(await tool('journey_prompt_profile_save').handler({
      profileId: 'doubao-photo',
      name: '豆包真实摄影',
      matchModel: 'doubao-seedream*',
      matchPreset: 'doubao',
      imageStyle: 'photorealistic natural light, 35mm film',
      imageCast: '',
      imageStyleCast: '',
    }));

    // 同一模型下手动微调，不应被覆盖
    parseJsonResult(await tool('journey_prompt_save').handler({
      imageStyle: 'qwen hand-tuned',
      reason: '同模型微调',
    }));
    assert.equal(cfg.imageStyle, 'qwen hand-tuned');

    // 通过生图设置面板切换模型到 doubao -> 自动备份旧值并切到豆包方案
    const ui = world.webUi();
    assert.ok(ui.panels.some((p) => p.id === 'prompts' && p.description.includes('frost77r')));
    const nextSettings = await ui.invoke('settings', 'saveImageSettings', [{
      imageProtocol: 'openai',
      imagePreset: 'doubao',
      imageModel: 'doubao-seedream-5-0-260128',
    }]);
    assert.equal(nextSettings.style, 'photorealistic natural light, 35mm film');
    assert.equal(cfg.imageStyle, 'photorealistic natural light, 35mm film');
    assert.equal(cfg.imageCast, '');

    // 检查 history 里记下了 auto-switch
    const ov = await ui.invoke('prompts', 'overview', []);
    assert.equal(ov.state.author, 'frost77r');
    assert.equal(ov.profiles.length, 2);
    const hist = await ui.invoke('prompts', 'historyList', [{ limit: 10 }]);
    assert.ok(hist.snapshots.some((s) => s.action === 'auto-switch' && s.beforeSummary.imageStyle.includes('qwen hand-tuned')));

    // 验证 envPromptVars 输出非空计数，且配置文件持久化在 journey-prompt-editor 目录
    const vars = world.envPromptVars();
    assert.equal(vars['journey.promptProfileCount'], '2');
    assert.equal(vars['journey.promptAutoSwitch'], '已开启');
    const savedProfiles = JSON.parse(readFileSync(join(dir, 'journey-prompt-editor', 'profiles.json'), 'utf8'));
    assert.equal(savedProfiles.profiles.length, 2);

    // 删除一套方案
    const del = parseJsonResult(await tool('journey_prompt_profile_delete').handler({ profileId: 'qwen-default' }));
    assert.equal(del.deleted, true);
    assert.equal(del.remainingCount, 1);

    await world.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
