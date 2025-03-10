import { test as anyTest } from '@agoric/zoe/tools/prepare-test-env-ava.js';

import '@agoric/zoe/exported.js';
import '../../src/vaultFactory/types.js';

import { AmountMath, makeIssuerKit } from '@agoric/ertp';
import { CONTRACT_ELECTORATE, ParamTypes } from '@agoric/governance';
import committeeBundle from '@agoric/governance/bundles/bundle-committee.js';
import { unsafeMakeBundleCache } from '@agoric/swingset-vat/tools/bundleTool.js';
import { makeBoard } from '@agoric/vats/src/lib-board.js';
import {
  floorDivideBy,
  floorMultiplyBy,
  makeRatio,
  natSafeMath as NatMath,
} from '@agoric/zoe/src/contractSupport/index.js';
import centralSupplyBundle from '@agoric/vats/bundles/bundle-centralSupply.js';
import { E } from '@endo/eventual-send';
import { NonNullish } from '@agoric/assert';
import path from 'path';
import { eventLoopIteration } from '@agoric/zoe/tools/eventLoopIteration.js';
import { makeTracer } from '../../src/makeTracer.js';
import {
  makeMockChainStorageRoot,
  mintRunPayment,
  setUpZoeForTest,
  subscriptionKey,
  withAmountUtils,
} from '../supports.js';

/** @type {import('ava').TestFn<Awaited<ReturnType<makeTestContext>>>} */
const test = anyTest;

const pathname = new URL(import.meta.url).pathname;
const dirname = path.dirname(pathname);

const psmRoot = `${dirname}/../../src/psm/psm.js`;
const trace = makeTracer('TestPSM', false);

const scale6 = x => BigInt(Math.round(x * 1_000_000));

const BASIS_POINTS = 10000n;
const WantMintedFeeBP = 1n;
const GiveMintedFeeBP = 3n;
const MINT_LIMIT = scale6(20_000_000);

/**
 * Compute the fee for giving an Amount in minted.
 *
 * @param {Amount<'nat'>} minted
 * @returns {Amount<'nat'>}
 */
const minusMintedFee = minted => {
  const feeBP = GiveMintedFeeBP;
  return AmountMath.make(
    minted.brand,
    NatMath.floorDivide(
      NatMath.multiply(minted.value, NatMath.subtract(BASIS_POINTS, feeBP)),
      BASIS_POINTS,
    ),
  );
};

/**
 * Compute the fee in the minted asset of an Amount given in anchor.
 *
 * @param {Amount<'nat'>} anchor
 * @param {Ratio} anchorPerMinted
 * @returns {Amount<'nat'>}
 */
const minusAnchorFee = (anchor, anchorPerMinted) => {
  const minted = floorDivideBy(anchor, anchorPerMinted);
  const feeBP = WantMintedFeeBP;
  return AmountMath.make(
    minted.brand,
    NatMath.floorDivide(
      NatMath.multiply(minted.value, NatMath.subtract(BASIS_POINTS, feeBP)),
      BASIS_POINTS,
    ),
  );
};

const makeTestContext = async () => {
  const bundleCache = await unsafeMakeBundleCache('bundles/');
  const psmBundle = await bundleCache.load(psmRoot, 'psm');
  const { zoe, feeMintAccessP } = await setUpZoeForTest();
  const feeMintAccess = await feeMintAccessP;

  const mintedIssuer = await E(zoe).getFeeIssuer();
  /** @type {IssuerKit<'nat'>} */
  // @ts-expect-error missing mint but it's not needed in the test
  const mintedKit = {
    issuer: mintedIssuer,
    brand: await E(mintedIssuer).getBrand(),
  };
  const minted = withAmountUtils(mintedKit);
  const anchor = withAmountUtils(makeIssuerKit('aUSD'));

  const committeeInstall = await E(zoe).install(committeeBundle);
  const psmInstall = await E(zoe).install(psmBundle);
  const centralSupply = await E(zoe).install(centralSupplyBundle);

  const marshaller = makeBoard().getReadonlyMarshaller();

  const { creatorFacet: committeeCreator } = await E(zoe).startInstance(
    committeeInstall,
    harden({}),
    {
      committeeName: 'Demos',
      committeeSize: 1,
    },
    {
      storageNode: makeMockChainStorageRoot().makeChildNode('thisCommittee'),
      marshaller,
    },
  );

  const initialPoserInvitation = await E(committeeCreator).getPoserInvitation();
  const invitationAmount = await E(E(zoe).getInvitationIssuer()).getAmountOf(
    initialPoserInvitation,
  );

  return {
    bundles: { psmBundle },
    zoe: await zoe,
    feeMintAccess,
    initialPoserInvitation,
    minted,
    anchor,
    installs: { committeeInstall, psmInstall, centralSupply },
    marshaller,
    terms: {
      anchorBrand: anchor.brand,
      anchorPerMinted: makeRatio(100n, anchor.brand, 100n, minted.brand),
      governedParams: {
        [CONTRACT_ELECTORATE]: {
          type: ParamTypes.INVITATION,
          value: invitationAmount,
        },
        GiveMintedFee: {
          type: ParamTypes.RATIO,
          value: makeRatio(GiveMintedFeeBP, minted.brand, BASIS_POINTS),
        },
        MintLimit: { type: ParamTypes.AMOUNT, value: minted.make(MINT_LIMIT) },
        WantMintedFee: {
          type: ParamTypes.RATIO,
          value: makeRatio(WantMintedFeeBP, minted.brand, BASIS_POINTS),
        },
      },
    },
  };
};

test.before(async t => {
  t.context = await makeTestContext();
});

/**
 *
 * @param {import('ava').ExecutionContext<Awaited<ReturnType<makeTestContext>>>} t
 * @param {{}} [customTerms]
 */
async function makePsmDriver(t, customTerms) {
  const {
    zoe,
    feeMintAccess,
    initialPoserInvitation,
    terms,
    installs: { psmInstall },
    anchor,
  } = t.context;

  // Each driver needs its own to avoid state pollution between tests
  const mockChainStorage = makeMockChainStorageRoot();

  /** @type {Awaited<ReturnType<import('../../src/psm/psm.js').start>>} */
  const { creatorFacet, publicFacet } = await E(zoe).startInstance(
    psmInstall,
    harden({ AUSD: anchor.issuer }),
    { ...terms, ...customTerms },
    harden({
      feeMintAccess,
      initialPoserInvitation,
      storageNode: mockChainStorage.makeChildNode('thisPsm'),
      marshaller: makeBoard().getReadonlyMarshaller(),
    }),
  );

  /**
   * @param {Amount<'nat'>} giveAnchor
   * @param {Amount<'nat'>} [wantMinted]
   */
  const swapAnchorForMintedSeat = async (giveAnchor, wantMinted) => {
    const seat = E(zoe).offer(
      E(publicFacet).makeWantMintedInvitation(),
      harden({
        give: { In: giveAnchor },
        ...(wantMinted ? { want: { Out: wantMinted } } : {}),
      }),
      harden({ In: anchor.mint.mintPayment(giveAnchor) }),
    );
    await eventLoopIteration();
    return seat;
  };

  /**
   * @param {Amount<'nat'>} giveRun
   * @param {Payment<'nat'>} runPayment
   * @param {Amount<'nat'>} [wantAnchor]
   */
  const swapMintedForAnchorSeat = async (giveRun, runPayment, wantAnchor) => {
    const seat = E(zoe).offer(
      E(publicFacet).makeGiveMintedInvitation(),
      harden({
        give: { In: giveRun },
        ...(wantAnchor ? { want: { Out: wantAnchor } } : {}),
      }),
      harden({ In: runPayment }),
    );
    await eventLoopIteration();
    return seat;
  };

  return {
    mockChainStorage,
    publicFacet,

    /** @param {Amount<'nat'>} expected */
    async assertPoolBalance(expected) {
      const balance = await E(publicFacet).getPoolBalance();
      t.deepEqual(balance, expected);
    },

    /** @type {(subpath: string) => object} */
    getStorageChildBody(subpath) {
      return mockChainStorage.getBody(
        `mockChainStorageRoot.thisPsm.${subpath}`,
      );
    },

    async getFeePayout() {
      const limitedCreatorFacet = E(creatorFacet).getLimitedCreatorFacet();
      const collectFeesSeat = await E(zoe).offer(
        E(limitedCreatorFacet).makeCollectFeesInvitation(),
      );
      await E(collectFeesSeat).getOfferResult();
      const feePayoutAmount = await E.get(
        E(collectFeesSeat).getFinalAllocation(),
      ).Fee;
      return feePayoutAmount;
    },

    /**
     * @param {Amount<'nat'>} giveAnchor
     * @param {Amount<'nat'>} [wantMinted]
     */
    async swapAnchorForMinted(giveAnchor, wantMinted) {
      const seat = swapAnchorForMintedSeat(giveAnchor, wantMinted);
      return E(seat).getPayouts();
    },
    swapAnchorForMintedSeat,

    /**
     * @param {Amount<'nat'>} giveAnchor
     * @param {Amount<'nat'>} [wantMinted]
     */
    async swapAnchorForMintedErrors(giveAnchor, wantMinted) {
      const seat = swapAnchorForMintedSeat(giveAnchor, wantMinted);
      return seat;
    },

    /**
     * @param {Amount<'nat'>} giveRun
     * @param {Payment<'nat'>} runPayment
     * @param {Amount<'nat'>} [wantAnchor]
     */
    async swapMintedForAnchor(giveRun, runPayment, wantAnchor) {
      const seat = swapMintedForAnchorSeat(giveRun, runPayment, wantAnchor);
      return E(seat).getPayouts();
    },
    swapMintedForAnchorSeat,
  };
}

test('simple trades', async t => {
  const { terms, minted, anchor } = t.context;
  const driver = await makePsmDriver(t);

  const giveAnchor = AmountMath.make(anchor.brand, scale6(200));

  const runPayouts = await driver.swapAnchorForMinted(giveAnchor);
  const expectedRun = minusAnchorFee(giveAnchor, terms.anchorPerMinted);
  const actualRun = await E(minted.issuer).getAmountOf(runPayouts.Out);
  t.deepEqual(actualRun, expectedRun);
  await driver.assertPoolBalance(giveAnchor);

  const giveRun = AmountMath.make(minted.brand, scale6(100));
  trace('get minted', { giveRun, expectedRun, actualRun });
  const [runPayment, _moreRun] = await E(minted.issuer).split(
    runPayouts.Out,
    giveRun,
  );
  const anchorPayouts = await driver.swapMintedForAnchor(giveRun, runPayment);
  const actualAnchor = await E(anchor.issuer).getAmountOf(anchorPayouts.Out);
  const expectedAnchor = AmountMath.make(
    anchor.brand,
    minusMintedFee(giveRun).value,
  );
  t.deepEqual(actualAnchor, expectedAnchor);
  await driver.assertPoolBalance(
    AmountMath.subtract(giveAnchor, expectedAnchor),
  );
  trace('get anchor', { runGive: giveRun, expectedRun, actualAnchor });

  // Check the fees
  // 1BP per anchor = 30000n plus 3BP per minted = 20000n
  const feePayoutAmount = await driver.getFeePayout();
  const expectedFee = AmountMath.make(minted.brand, 50000n);
  trace('Reward Fee', { feePayoutAmount, expectedFee });
  t.truthy(AmountMath.isEqual(feePayoutAmount, expectedFee));
});

test('limit', async t => {
  const { anchor } = t.context;

  const driver = await makePsmDriver(t);

  const initialPool = AmountMath.make(anchor.brand, 1n);
  await driver.swapAnchorForMinted(initialPool);
  await driver.assertPoolBalance(initialPool);

  trace('test going over limit');
  const give = anchor.make(MINT_LIMIT);
  const seat = await driver.swapAnchorForMintedErrors(give);
  await t.throwsAsync(async () => E(seat).getOfferResult());

  const paymentPs = await E(seat).getPayouts();
  trace('gone over limit');
  // We should get 0 Minted  and all our anchor back
  t.falsy(paymentPs.Out);
  const anchorReturn = await paymentPs.In;
  const actualAnchor = await E(anchor.issuer).getAmountOf(anchorReturn);
  t.deepEqual(actualAnchor, give);
  // The pool should be unchanged
  driver.assertPoolBalance(initialPool);
});

test('limit is for minted', async t => {
  const { minted, anchor } = t.context;
  // only 50 minted allowed per anchor
  const anchorPerMinted = makeRatio(50n, anchor.brand, 100n, minted.brand);
  const driver = await makePsmDriver(t, { anchorPerMinted });

  trace('test going over limit');
  const giveTooMuch = anchor.make(MINT_LIMIT);
  const seat1 = await driver.swapAnchorForMintedSeat(giveTooMuch);
  t.throwsAsync(
    () => E(seat1).getOfferResult(),
    {
      message: 'Request would exceed mint limit',
    },
    'limit is enforced on the Minted rather than Anchor',
  );

  trace('test right at limit');
  const give = anchor.make(MINT_LIMIT / 2n);
  await t.notThrowsAsync(
    driver.swapAnchorForMinted(give),
    'swap at minted limit',
  );
});

/** @type {[kind: 'want' | 'give', give: number, want: number, ok: boolean, wants?: number][]} */
const trades = [
  ['give', 200, 190, false],
  ['want', 101, 100, true, 1],
  ['give', 50, 50, false],
  ['give', 51, 50, true, 1],
];

test('mix of trades: failures do not prevent later service', async t => {
  const {
    terms,
    minted,
    anchor,
    feeMintAccess,
    zoe,
    installs: { centralSupply },
  } = t.context;
  const driver = await makePsmDriver(t);

  const ist100 = await mintRunPayment(scale6(500), {
    centralSupply,
    feeMintAccess,
    zoe,
  });

  assert(anchor.issuer);
  const anchorPurse = await E(anchor.issuer).makeEmptyPurse();
  const mintedPurse = await E(minted.issuer).makeEmptyPurse();
  await E(mintedPurse).deposit(ist100);

  const wantMinted = async (ix, give, want, ok, wants) => {
    t.log('wantMinted', ix, give, want, ok, wants);
    const giveAnchor = AmountMath.make(anchor.brand, scale6(give));
    const wantAmt = AmountMath.make(minted.brand, scale6(want));
    const seat = await driver.swapAnchorForMintedSeat(giveAnchor, wantAmt);
    if (!ok) {
      await t.throwsAsync(E(seat).getOfferResult());
      return;
    }
    await E(seat).getOfferResult();
    t.is(await E(seat).numWantsSatisfied(), wants);
    if (wants === 0) {
      return;
    }
    const runPayouts = await E(seat).getPayouts();
    const expectedRun = minusAnchorFee(giveAnchor, terms.anchorPerMinted);
    const actualRun = await E(mintedPurse).deposit(await runPayouts.Out);
    t.deepEqual(actualRun, expectedRun);
  };

  const giveMinted = async (ix, give, want, ok, wants) => {
    t.log('giveMinted', ix, give, want, ok, wants);
    const giveRun = AmountMath.make(minted.brand, scale6(give));
    const runPayment = await E(mintedPurse).withdraw(giveRun);
    const wantAmt = AmountMath.make(anchor.brand, scale6(want));
    const seat = await driver.swapMintedForAnchorSeat(
      giveRun,
      runPayment,
      wantAmt,
    );
    const anchorPayouts = await E(seat).getPayouts();
    if (!ok) {
      await t.throwsAsync(E(seat).getOfferResult());
      return;
    }
    await E(seat).getOfferResult();

    t.is(await E(seat).numWantsSatisfied(), wants);
    if (wants === 0) {
      return;
    }
    const actualAnchor = await E(anchorPurse).deposit(await anchorPayouts.Out);
    const expectedAnchor = AmountMath.make(
      anchor.brand,
      minusMintedFee(giveRun).value,
    );
    t.deepEqual(actualAnchor, expectedAnchor);
  };

  let ix = 0;
  for (const [kind, give, want, ok, wants] of trades) {
    switch (kind) {
      case 'give':
        // eslint-disable-next-line no-await-in-loop
        await giveMinted(ix, give, want, ok, wants);
        break;
      case 'want':
        // eslint-disable-next-line no-await-in-loop
        await wantMinted(ix, give, want, ok, wants);
        break;
      default:
        assert.fail(kind);
    }
    if (kind === 'give') {
      // eslint-disable-next-line no-await-in-loop
    }
    ix += 1;
  }
});

test('anchor is 2x minted', async t => {
  const { minted, anchor } = t.context;
  const anchorPerMinted = makeRatio(200n, anchor.brand, 100n, minted.brand);
  const driver = await makePsmDriver(t, { anchorPerMinted });

  const giveAnchor = AmountMath.make(anchor.brand, scale6(400));
  const runPayouts = await driver.swapAnchorForMinted(giveAnchor);

  const expectedRun = minusAnchorFee(giveAnchor, anchorPerMinted);
  const actualRun = await E(minted.issuer).getAmountOf(runPayouts.Out);
  t.deepEqual(actualRun, expectedRun);

  driver.assertPoolBalance(giveAnchor);

  const giveRun = AmountMath.make(minted.brand, scale6(100));
  trace('get minted ratio', { giveRun, expectedRun, actualRun });
  const [runPayment, _moreRun] = await E(minted.issuer).split(
    runPayouts.Out,
    giveRun,
  );
  const anchorPayouts = await driver.swapMintedForAnchor(giveRun, runPayment);
  const actualAnchor = await E(anchor.issuer).getAmountOf(anchorPayouts.Out);
  const expectedAnchor = floorMultiplyBy(
    minusMintedFee(giveRun),
    anchorPerMinted,
  );
  t.deepEqual(actualAnchor, expectedAnchor);
  driver.assertPoolBalance(AmountMath.subtract(giveAnchor, expectedAnchor));
  trace('get anchor', { runGive: giveRun, expectedRun, actualAnchor });
});

test('governance', async t => {
  const driver = await makePsmDriver(t);
  t.is(
    await subscriptionKey(E(driver.publicFacet).getSubscription()),
    'mockChainStorageRoot.thisPsm.governance',
  );

  t.like(driver.getStorageChildBody('governance'), {
    current: {
      Electorate: { type: 'invitation' },
      GiveMintedFee: { type: 'ratio' },
      MintLimit: { type: 'amount' },
      WantMintedFee: { type: 'ratio' },
    },
  });
});

test('metrics', async t => {
  const driver = await makePsmDriver(t);
  t.is(
    await subscriptionKey(E(driver.publicFacet).getMetrics()),
    'mockChainStorageRoot.thisPsm.metrics',
  );

  const { anchor, minted } = t.context;
  // Test keys and brands, then assume they don't change
  t.deepEqual(Object.keys(driver.getStorageChildBody('metrics')), [
    'anchorPoolBalance',
    'feePoolBalance',
    'mintedPoolBalance',
    'totalAnchorProvided',
    'totalMintedProvided',
  ]);
  t.like(driver.getStorageChildBody('metrics'), {
    anchorPoolBalance: { brand: { iface: 'Alleged: aUSD brand' }, value: 0n },
    feePoolBalance: { brand: { iface: 'Alleged: IST brand' }, value: 0n },
    mintedPoolBalance: {
      brand: { iface: 'Alleged: IST brand' },
      value: 0n,
    },
    totalAnchorProvided: {
      brand: { iface: 'Alleged: aUSD brand' },
      value: 0n,
    },
    totalMintedProvided: {
      brand: { iface: 'Alleged: IST brand' },
      value: 0n,
    },
  });
  const giveAnchor = anchor.make(scale6(200));

  // grow the pool
  const mintedPayouts = await driver.swapAnchorForMinted(giveAnchor);
  t.like(driver.getStorageChildBody('metrics'), {
    anchorPoolBalance: {
      value: giveAnchor.value,
    },
    feePoolBalance: { value: 20_000n },
    mintedPoolBalance: {
      brand: { iface: 'Alleged: IST brand' },
      value: giveAnchor.value,
    },
    totalAnchorProvided: {
      value: 0n,
    },
    totalMintedProvided: {
      value: giveAnchor.value,
    },
  });

  // no change
  await driver.swapAnchorForMinted(anchor.make(0n));
  t.like(driver.getStorageChildBody('metrics'), {
    anchorPoolBalance: {
      value: giveAnchor.value,
    },
    feePoolBalance: { value: 20_000n },
    mintedPoolBalance: {
      brand: { iface: 'Alleged: IST brand' },
      value: giveAnchor.value,
    },
    totalAnchorProvided: {
      value: 0n,
    },
    totalMintedProvided: {
      value: giveAnchor.value,
    },
  });

  // get anchor
  const giveMinted = AmountMath.make(minted.brand, scale6(100));
  const [runPayment, _moreRun] = await E(minted.issuer).split(
    mintedPayouts.Out,
    giveMinted,
  );
  const fee = 30_000n;
  await driver.swapMintedForAnchor(giveMinted, runPayment);
  t.like(driver.getStorageChildBody('metrics'), {
    anchorPoolBalance: {
      value: giveMinted.value + fee,
    },
    feePoolBalance: { value: 50_000n },
    mintedPoolBalance: {
      brand: { iface: 'Alleged: IST brand' },
      value: giveAnchor.value - giveMinted.value + fee,
    },
    totalAnchorProvided: {
      value: giveMinted.value - fee,
    },
    totalMintedProvided: {
      value: giveAnchor.value,
    },
  });
});

test('wrong give giveMintedInvitation', async t => {
  const { zoe, anchor } = t.context;
  const { publicFacet } = await makePsmDriver(t);
  const giveAnchor = AmountMath.make(anchor.brand, scale6(200));
  await t.throwsAsync(
    () =>
      E(zoe).offer(
        E(publicFacet).makeGiveMintedInvitation(),
        harden({ give: { In: giveAnchor } }),
        harden({ In: NonNullish(anchor.mint).mintPayment(giveAnchor) }),
      ),
    {
      message:
        '"giveMinted" proposal: give: In: brand: "[Alleged: aUSD brand]" - Must be: "[Alleged: IST brand]"',
    },
  );
});

test('wrong give wantMintedInvitation', async t => {
  const {
    minted,
    feeMintAccess,
    zoe,
    installs: { centralSupply },
  } = t.context;
  const { publicFacet } = await makePsmDriver(t);
  const istValue = scale6(100);
  const giveIST = AmountMath.make(minted.brand, istValue);
  const istPayment = await mintRunPayment(istValue, {
    centralSupply,
    feeMintAccess,
    zoe,
  });
  await t.throwsAsync(
    () =>
      E(zoe).offer(
        E(publicFacet).makeWantMintedInvitation(),
        harden({ give: { In: giveIST } }),
        harden({ In: istPayment }),
      ),
    {
      message:
        '"wantMinted" proposal: give: In: brand: "[Alleged: IST brand]" - Must be: "[Alleged: aUSD brand]"',
    },
  );
});

test('extra give wantMintedInvitation', async t => {
  const { zoe, anchor } = t.context;
  const { publicFacet } = await makePsmDriver(t);
  const giveAnchor = AmountMath.make(anchor.brand, scale6(200));
  const mint = NonNullish(anchor.mint);
  await t.throwsAsync(
    () =>
      E(zoe).offer(
        E(publicFacet).makeWantMintedInvitation(),
        harden({ give: { In: giveAnchor, Extra: giveAnchor } }),
        harden({
          In: mint.mintPayment(giveAnchor),
          Extra: mint.mintPayment(giveAnchor),
        }),
      ),
    {
      message:
        /"wantMinted" proposal: .* - Must not have unexpected properties: \["Extra"\]/,
    },
  );
});
