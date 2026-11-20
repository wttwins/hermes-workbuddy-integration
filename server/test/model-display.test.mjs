import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withFreeLabel } from '../src/model-display.mjs';

describe('零倍率模型名称展示', () => {
  test('已知数值零倍率追加 Free，不修改原始名称变量', () => {
    const name = 'Hy3';
    assert.equal(withFreeLabel(name, 0), 'Hy3 (Free)');
    assert.equal(name, 'Hy3');
  });

  for (const rate of [0.03, 0.29, 1, 6.67, -0.29]) {
    test(`非零倍率 ${rate} 不添加 Free`, () => {
      assert.equal(withFreeLabel('Model', rate), 'Model');
    });
  }

  for (const [label, rate] of [
    ['missing', undefined], ['null', null], ['Infinity', Infinity],
    ['NaN', NaN], ['numeric string', '0'], ['false', false], ['true', true],
  ]) {
    test(`未知或非数值倍率 ${label} 不推断免费`, () => {
      assert.equal(withFreeLabel('Model', rate), 'Model');
    });
  }

  test('站点显式关闭时零倍率也保持原名', () => {
    assert.equal(withFreeLabel('Hy3', 0, false), 'Hy3');
  });

  test('非布尔开关不会意外启用标注', () => {
    assert.equal(withFreeLabel('Hy3', 0, 'true'), 'Hy3');
  });

  for (const name of ['Hy3 (Free)', 'Hy3 (free)', 'Free Model', 'Hy3（免费）']) {
    test(`上游已有免费标记不重复追加：${name}`, () => {
      assert.equal(withFreeLabel(name, 0), name);
    });
  }

  test('free 只是其他词的一部分时仍追加标签', () => {
    assert.equal(withFreeLabel('Freeform Model', 0), 'Freeform Model (Free)');
  });

  test('价格变化不会把展示标签污染到原始模型信息', () => {
    const info = Object.freeze({ id: 'hy3', name: 'Hy3' });
    assert.equal(withFreeLabel(info.name, 0), 'Hy3 (Free)');
    assert.equal(withFreeLabel(info.name, 0.29), 'Hy3');
    assert.deepEqual(info, { id: 'hy3', name: 'Hy3' });
  });
});
