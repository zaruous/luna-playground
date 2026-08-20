import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageProviderAdapter, UsageProviderRegistry } from '../service/providers/contracts.mjs';

class FakeProvider extends UsageProviderAdapter {
  constructor(id) {
    super({ id, name:id.toUpperCase(), capabilities:{ localLedger:true } });
    this.started = false;
  }

  async start() { this.started = true; }

  stop() { this.started = false; }

  async reconcile(reason) { return { changed:true, reason }; }

  getStatus() { return { provider:this.id, detected:true, watching:this.started }; }
}

test('provider registry owns lifecycle and forwards normalized events', async () => {
  const fake = new FakeProvider('fake');
  const registry = new UsageProviderRegistry({
    adapters:[fake],
    catalog:[{ id:'fake', name:'FAKE', order:1, integration:'planned' }],
  });
  let forwarded = null;
  registry.on('updated', (event) => { forwarded = event; });
  await registry.startAll();
  fake.emit('updated', { usageEvents:1 });
  assert.equal(registry.describe()[0].integration, 'connected');
  assert.equal(registry.describe()[0].collector.watching, true);
  assert.deepEqual(forwarded, { provider:'fake', usageEvents:1 });
  assert.deepEqual(await registry.reconcileAll('test'), [{ provider:'fake', changed:true, reason:'test' }]);
  registry.stopAll();
  assert.equal(fake.started, false);
});
