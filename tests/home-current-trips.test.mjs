import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const code = name => {
  const start = page.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name);
  return page.slice(start, page.indexOf('\n}', start) + 2);
};
const context = vm.createContext({});
for (const name of ['uMs', 'hmTripLoads', 'hmReadTrips']) vm.runInContext(code(name), context);
// The application normalizes visible order numbers before deciding whether to drop duplicate rows.
vm.runInContext(page.split('\n').find(line => line.startsWith('function onKey_(')), context);
const trip = { order_number: 'broker-ref', internal_load_id: 'T1', driver_id_sd: 'D1',
  status: 'picked_up', driver_name: 'Former driver', pickup_completed: '2026-11-18T14:00:00Z',
  delivery_completed: '2026-11-14T15:00:00Z' };
const source = { trip: 'T1', driver: 'D1', pickup: '2026-11-18T09:00:00-05:00' };
const inputs = (row = source) => ({
  names: new Map([['D1', 'Current driver']]), source: new Map([['broker-ref', row]])
});
const apply = (record, data = inputs()) => context.hmTripLoads([record], [record], data)[0];

test('a current pickup uses its verified driver and ignores an earlier delivery only on Home', () => {
  const display = apply(trip);
  assert.equal(display.driver_name, 'Current driver');
  assert.equal(display.delivery_completed, null);
  assert.equal(trip.driver_name, 'Former driver');
  assert.ok(trip.delivery_completed);
});
test('completed, canceled, chronologically possible and mismatched rows are preserved', () => {
  for (const changes of [{status:'delivered'}, {is_canceled:true}, {internal_load_id:'T2'},
    {driver_id_sd:'D2'}, {delivery_completed:'2026-11-18T15:00:00Z'}, {pickup_completed:null}]) {
    const row = {...trip, ...changes};
    assert.equal(apply(row), row);
  }
  assert.equal(apply(trip, {...inputs(), names:new Map()}), trip);
  assert.equal(apply(trip, inputs({...source, pickup:'invalid'})), trip);
});
test('similar references preserve distinct known trips without reviving another copy of the same trip', () => {
  const alias = {...trip, order_number:'broker-ref.', internal_load_id:'T2', status:'delivered'};
  const render = kept => context.hmTripLoads(kept, [trip, ...kept], inputs());
  assert.equal(render([alias]).length, 2);
  assert.equal(render([{...alias, internal_load_id:'T1'}]).length, 1);
  assert.equal(render([{...alias, internal_load_id:null}]).length, 1);
  assert.equal(render([alias, {...alias, order_number:'different-ref', internal_load_id:'T1'}]).length, 2);
});
test('the source query requires explicit undelivered and non-canceled facts and a company-scoped registry link', async () => {
  const filters = [];
  const builder = Object.fromEntries(['select','eq','is','contains'].map(key => [key,
    (...args) => { filters.push([key,...args]); return builder; }]));
  context.selAll_ = async build => { build(); return [{order_number:trip.order_number, ...source}]; };
  const getDirectory = co => ({company_id:co, verified:true, drivers:[{driver_id_sd:'D1', link:{
    row:{active:true, name:co === 'A' ? 'Current driver' : 'Other company driver'}}}]});
  context.sb = {from:() => builder, rpc:async (name, args) => {
    assert.equal(name, 'sd_directory_v1'); return {data:getDirectory(args.p_company_id)};
  }};
  assert.equal(apply(trip, await context.hmReadTrips('A', [trip])).driver_name, 'Current driver');
  assert.equal(apply(trip, await context.hmReadTrips('B', [trip])).driver_name, 'Other company driver');
  assert.deepEqual(filters.filter(x=>x[0]==='eq' && x[1]==='company_id').map(x=>x[2]), ['A','B']);
  assert.deepEqual(JSON.parse(JSON.stringify(filters.find(x=>x[0]==='contains'))),
    ['contains','raw',{status:'picked_up', is_canceled:false, delivery_completed:null}]);
  context.sb.rpc = async () => ({data:{...getDirectory('A'), verified:false}});
  assert.equal(apply(trip, await context.hmReadTrips('A', [trip])), trip);
  context.sb.rpc = async () => ({data:getDirectory('B')});
  assert.ok((await context.hmReadTrips('A', [trip])).error);
});
