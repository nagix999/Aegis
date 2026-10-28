import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { scaffoldPolicyExample } from '../components/policy-example-scaffold.ts';

test('scaffold adds nested required placeholders without replacing or removing business expectations', () => {
  const schema = {type: 'object', properties: {risk: {type: 'object', properties: {score: {type: 'integer'}, explanation: {type: 'string'}}, required: ['score', 'explanation']}, legacy: {type: 'integer'}}, required: ['risk']};
  const source = '{"risk":{"score":91},"outside":"keep me","legacy":"wrong type but never overwrite"}';
  const result = scaffoldPolicyExample(schema, source);
  assert.deepEqual(JSON.parse(result.source), {risk: {score: 91, explanation: ''}, outside: 'keep me', legacy: 'wrong type but never overwrite'});
  assert.deepEqual(result.added, ['/risk/explanation']);
  assert.equal(scaffoldPolicyExample(schema, result.source).added.length, 0);
});
test('enum, const, references and unions require a manual expectation instead of guessing', () => {
  const schema = {type: 'object', properties: {route: {type: 'string', enum: ['main', 'error']}, fixed: {const: 'yes'}, ref: {$ref: '#/$defs/value'}, union: {type: ['string', 'null']}}, required: ['route', 'fixed', 'ref', 'union']};
  const result = scaffoldPolicyExample(schema, '{}');
  assert.equal(result.source, '{}'); assert.deepEqual(result.added, []); assert.equal(result.skipped.length, 4);
});
test('array members and escaped names are supported while invalid raw JSON stays intact', () => {
  const schema = {type: 'array', items: {type: 'object', properties: {'a/b~c': {type: 'boolean'}}, required: ['a/b~c']}};
  const result = scaffoldPolicyExample(schema, '[{}, {"a/b~c":true}]');
  assert.deepEqual(JSON.parse(result.source), [{'a/b~c': false}, {'a/b~c': true}]);
  assert.deepEqual(result.added, ['/0/a~1b~0c']);
  assert.deepEqual(scaffoldPolicyExample(schema, '['), {source: '[', added: [], skipped: [], error: '예상 JSON 문법을 먼저 수정하세요.'});
});
test('new objects are finite, optional fields stay absent and prototype keys remain plain JSON', () => {
  const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"optional":{"type":"integer"}},"required":["__proto__"]}');
  const result = scaffoldPolicyExample(schema, '{}');
  assert.equal(Object.hasOwn(JSON.parse(result.source), '__proto__'), true); assert.equal(Object.hasOwn(JSON.parse(result.source), 'optional'), false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
test('number overflow and extreme nesting cannot silently rewrite or crash existing expected answers', () => {
  const schema = {type:'object',properties:{note:{type:'string'}},required:['note']};
  const overflow = '{"score":1e400}';
  const result = scaffoldPolicyExample(schema,overflow);
  assert.equal(result.source,overflow);assert.ok(result.error);assert.deepEqual(result.added,[]);
  const deep = '['.repeat(100)+'0'+']'.repeat(100);
  const bounded = scaffoldPolicyExample(schema,deep);
  assert.equal(bounded.source,deep);assert.ok(bounded.error);
});
