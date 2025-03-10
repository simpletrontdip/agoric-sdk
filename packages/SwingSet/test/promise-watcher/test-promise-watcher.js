import os from 'os';
// eslint-disable-next-line import/order
import { handleUnhandledRejections } from './unhandledRejectionDetector.js';

// eslint-disable-next-line import/order
import { test } from '../../tools/prepare-test-env-ava.js';

// eslint-disable-next-line import/order
import { assert } from '@agoric/assert';
// eslint-disable-next-line import/order
import { initSwingStore, getAllState } from '@agoric/swing-store';
import { initializeSwingset, makeSwingsetController } from '../../src/index.js';

function bfile(name) {
  return new URL(name, import.meta.url).pathname;
}

// eslint-disable-next-line no-unused-vars
function dumpState(kernelStorage, vatID) {
  const s = getAllState(kernelStorage).kvStuff;
  const keys = Array.from(Object.keys(s)).sort();
  for (const k of keys) {
    if (k.startsWith(`${vatID}.vs.`)) {
      console.log(k, s[k]);
    }
  }
}

async function testPromiseWatcher(t) {
  const config = {
    includeDevDependencies: true, // for vat-data
    bootstrap: 'bootstrap',
    vats: {
      bootstrap: { sourceSpec: bfile('bootstrap-promise-watcher.js') },
    },
    bundles: {
      upton: { sourceSpec: bfile('vat-upton.js') },
    },
  };

  const unhandledRejections = [];
  handleUnhandledRejections(rej => unhandledRejections.push(rej));

  const kernelStorage = initSwingStore().kernelStorage;
  // ? const { kvStore } = kernelStorage;
  await initializeSwingset(config, [], kernelStorage);
  const c = await makeSwingsetController(kernelStorage);
  t.teardown(c.shutdown);
  c.pinVatRoot('bootstrap');
  await c.run();

  async function run(method, args = []) {
    assert(Array.isArray(args));
    const kpid = c.queueToVatRoot('bootstrap', method, args);
    await c.run();
    const status = c.kpStatus(kpid);
    const result = c.kpResolution(kpid);
    return [status, result];
  }

  // create initial version
  const [v1status /* , v1capdata */] = await run('buildV1', []);
  t.is(v1status, 'fulfilled');
  const beforeReference = [
    'lp1-pw resolved lval1 version v1 via watcher []',
    'lp1-dk resolved lval1 version v1 via VDO',
    'lp2-pw rejected "lerr2" version v1 via watcher []',
    'lp2-dk rejected "lerr2" version v1 via VDO',
    'rp1-pw resolved rvalbefore version v1 via watcher []',
    'rp1-dk resolved rvalbefore version v1 via VDO',
    'rp2-pw rejected "rerrbefore" version v1 via watcher []',
    'rp2-dk rejected "rerrbefore" version v1 via VDO',
    'p1-pw resolved val1 version v1 via watcher []',
    'p1-dk.full resolved val1 version v1 via VDO',
    'p1-dk.res resolved val1 version v1 via VDO (res)',
    'p2-pw rejected "err2" version v1 via watcher [a]',
    'p2-dk.full rejected "err2" version v1 via VDO',
    'p2-dk.rej rejected "err2" version v1 via VDO (rej)',
  ];
  t.deepEqual(c.dump().log, beforeReference);
  if (os.platform() === 'darwin') {
    // this will not work in CI but can at least validate things locally
    t.deepEqual(unhandledRejections, ['err2']);
  }

  // now perform the upgrade
  // console.log(`-- starting upgradeV2`);
  const [v2status /* , v2capdata */] = await run('upgradeV2', []);
  t.is(v2status, 'fulfilled');
  const doString =
    '{"incarnationNumber":1,"name":"vatUpgraded","upgradeMessage":"test upgrade"}';
  t.deepEqual(c.dump().log, [
    ...beforeReference,
    `lp3-pw rejected ${doString} version v2 via watcher []`,
    `lp3-dk rejected ${doString} version v2 via VDO`,
    `lp4-pw rejected ${doString} version v2 via watcher []`,
    `lp4-dk rejected ${doString} version v2 via VDO`,
    'p3-pw resolved val3 version v2 via watcher [b,c]',
    'p3-dk.full resolved val3 version v2 via VDO',
    'p3-dk.res resolved val3 version v2 via VDO (res)',
    'p4-pw rejected "err4" version v2 via watcher [d,e,f]',
    'p4-dk.full rejected "err4" version v2 via VDO',
    'p4-dk.rej rejected "err4" version v2 via VDO (rej)',
    'rp3-pw resolved rvalafter version v2 via watcher []',
    'rp3-dk resolved rvalafter version v2 via VDO',
    'rp4-pw rejected "rerrafter" version v2 via watcher []',
    'rp4-dk rejected "rerrafter" version v2 via VDO',
  ]);
  if (os.platform() === 'darwin') {
    t.deepEqual(unhandledRejections, ['err2', 'err4']);
  }
}

test('promise watcher', async t => {
  return testPromiseWatcher(t);
});
