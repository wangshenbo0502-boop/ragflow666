import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflows, workflowDSL } from './rail-workflows.mjs';

const endPaths = {
  'license-review': ['Message:Checklist', 'Message:Scope'],
  'acceptance-evidence': ['Message:Mismatch', 'Message:Reconciliation'],
  'revision-impact': ['Message:Impact'],
  'corrective-closeout': ['Message:Retest', 'Message:Signoff', 'Message:Unlinked'],
};

for (const def of workflows) {
  test(`${def.key}: canvas and runtime agree`, () => {
    const { graph, components } = workflowDSL(def, { model: 'model', primary: ['domain'], reference: ['cross-domain'] });
    const visit = (id, stack = []) => {
      assert.ok(components[id] && !stack.includes(id), `Invalid path: ${[...stack, id]}`);
      return [id, ...components[id].downstream.flatMap(next => visit(next, [...stack, id]))];
    };
    assert.deepEqual(new Set(visit('begin')), new Set(Object.keys(components)));
    for (const { id, data } of graph.nodes) {
      const { upstream, downstream, obj } = components[id];
      assert.deepEqual(upstream, graph.edges.filter(e => e.target === id).map(e => e.source));
      assert.deepEqual(downstream, graph.edges.filter(e => e.source === id).map(e => e.target));
      assert.deepEqual(obj, { component_name: data.label, params: data.form });
      const parents = new Set(upstream);
      for (const ancestor of parents) components[ancestor].upstream.forEach(parent => parents.add(parent));
      for (const [, reference] of JSON.stringify(data.form).matchAll(/\{([\w:]+)@/g)) {
        assert.ok(parents.has(reference), `${id} reads ${reference} without an upstream dependency`);
      }
      if (data.label === 'Switch') {
        assert.deepEqual(data.form.conditions.flatMap(c => c.to).concat(data.form.end_cpn_ids).sort(), [...downstream].sort());
        data.form.conditions.forEach(({ to: [target] }, index) => {
          assert.ok(graph.edges.some(e => e.source === id && e.target === target && e.sourceHandle === `Case ${index + 1}`));
        });
        for (const target of data.form.end_cpn_ids) {
          assert.ok(graph.edges.some(e => e.source === id && e.target === target && e.sourceHandle === 'end_cpn_ids'));
        }
      }
    }
    assert.deepEqual(Object.keys(components).filter(id => !components[id].downstream.length).sort(), endPaths[def.key]);
  });
}

test('workflow drawings match their business paths', () => {
  const [license, acceptance, revision, corrective] = workflows.map(def => workflowDSL(def).components);
  assert.deepEqual(license['Retrieval:Requirements'].upstream, ['Switch:Scope']);
  assert.deepEqual(acceptance['Agent:Reconcile'].upstream, ['Retrieval:Criteria', 'Retrieval:Measurement', 'Retrieval:Custody']);
  assert.deepEqual(revision['Agent:Delta'].upstream, ['Agent:Baseline', 'Agent:Amendment']);
  assert.deepEqual(corrective['Agent:Signoff'].upstream, ['Switch:Retest']);
  assert.equal(new Set(workflows.map(def => def.stroke)).size, workflows.length);
  assert.equal(new Set(workflows.map(def => def.avatar)).size, workflows.length);
});
