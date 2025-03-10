import '@agoric/zoe/exported.js';
import '@agoric/zoe/src/contracts/exported.js';

import '@agoric/governance/exported.js';
import { E } from '@endo/eventual-send';

import { fit, keyEQ, M, makeScalarMap } from '@agoric/store';
import {
  assertProposalShape,
  getAmountIn,
  getAmountOut,
} from '@agoric/zoe/src/contractSupport/index.js';
import { makeRatioFromAmounts } from '@agoric/zoe/src/contractSupport/ratio.js';
import { Far } from '@endo/marshal';

import { AmountMath, AmountShape, BrandShape, IssuerShape } from '@agoric/ertp';
import {
  makeStoredPublisherKit,
  observeIteration,
  SubscriberShape,
} from '@agoric/notifier';
import {
  defineDurableFarClassKit,
  makeKindHandle,
  makeScalarBigMapStore,
} from '@agoric/vat-data';
import { assertKeywordName } from '@agoric/zoe/src/cleanProposal.js';
import { makeMakeCollectFeesInvitation } from '../collectFees.js';
import { makeMetricsPublisherKit } from '../contractSupport.js';
import {
  CHARGING_PERIOD_KEY,
  makeVaultParamManager,
  RECORDING_PERIOD_KEY,
  SHORTFALL_INVITATION_KEY,
  vaultParamPattern,
} from './params.js';
import { makeVaultManager } from './vaultManager.js';

const { details: X, quote: q, Fail } = assert;

/** @typedef {{
 * debtMint: ZCFMint<'nat'>,
 * directorParamManager: import('@agoric/governance/src/contractGovernance/typedParamManager').TypedParamManager<import('./params.js').VaultDirectorParams>,
 * marshaller: ERef<Marshaller>,
 * metricsPublication: IterationObserver<MetricsNotification>
 * metricsSubscription: StoredSubscription<MetricsNotification>
 * shortfallReporter: import('../reserve/assetReserve.js').ShortfallReporter,
 * storageNode: ERef<StorageNode>,
 * vaultParamManagers: Store<Brand, import('./params.js').VaultParamManager>,
 * zcf: import('./vaultFactory.js').VaultFactoryZCF,
 * }} Ephemera
 */

/**
 * Ephemera is the state we cannot (or merely need not) keep durably. For
 * vaultDirector we can keep it in module scope because there is (exactly) one
 * vaultDirector per vaultFactory contract and (exactly) one contract per vat.
 *
 * @type {Ephemera}
 */
// @ts-expect-error not actually full until after initState
// UNTIL resolution to https://github.com/Agoric/agoric-sdk/issues/5759
const ephemera = {};

/**
 * @typedef {{
 * collaterals: Brand[],
 * rewardPoolAllocation: AmountKeywordRecord,
 * }} MetricsNotification
 *
 * @typedef {Readonly<{
 * collateralTypes: Store<Brand,VaultManager>,
 * mintSeat: ZCFSeat,
 * rewardPoolSeat: ZCFSeat,
 * shortfallInvitation: Invitation,
 * }>} ImmutableState
 *
 * @typedef {{
 * managerCounter: number,
 * }} MutableState
 *
 * @typedef {ImmutableState & MutableState} State
 *
 * @typedef {{
 *  burnDebt: BurnDebt,
 *  getGovernedParams: () => import('./vaultManager.js').GovernedParamGetters,
 *  mintAndReallocate: MintAndReallocate,
 *  getShortfallReporter: () => Promise<import('../reserve/assetReserve.js').ShortfallReporter>,
 * }} FactoryPowersFacet
 *
 * @typedef {Readonly<{
 *   state: State;
 * }>} MethodContext
 */
// FIXME find a way to type 'finish' with the context (state and facets)

/**
 * @param {ERef<ZoeService>} zoe
 * @param {Ephemera['directorParamManager']} paramMgr
 * @param {import('../reserve/assetReserve.js').ShortfallReporter} [oldShortfallReporter]
 * @param {ERef<Invitation>} [oldInvitation]
 * @returns {Promise<{
 *   shortfallInvitation: ERef<Invitation>,
 *   shortfallReporter: import('../reserve/assetReserve.js').ShortfallReporter,
 * }>}
 */
const updateShortfallReporter = async (
  zoe,
  paramMgr,
  oldShortfallReporter,
  oldInvitation,
) => {
  const newInvitation = paramMgr.getInternalParamValue(
    SHORTFALL_INVITATION_KEY,
  );

  if (newInvitation !== oldInvitation) {
    return {
      // @ts-expect-error cast
      shortfallReporter: E(E(zoe).offer(newInvitation)).getOfferResult(),
      shortfallInvitation: newInvitation,
    };
  } else {
    assert(
      oldShortfallReporter,
      'updateShortFallReported called with repeat invitation and no oldShortfallReporter',
    );
    return {
      shortfallReporter: oldShortfallReporter,
      shortfallInvitation: oldInvitation,
    };
  }
};

/**
 * @param {Pick<State, 'collateralTypes' | 'rewardPoolSeat'>} state
 * @returns {MetricsNotification}
 */
const metricsOf = state => {
  return harden({
    collaterals: Array.from(state.collateralTypes.keys()),
    rewardPoolAllocation: state.rewardPoolSeat.getCurrentAllocation(),
  });
};

/**
 * @param {Ephemera['zcf']} zcf
 * @param {Ephemera['directorParamManager']} directorParamManager
 * @param {Ephemera['debtMint']} debtMint
 * @param {ERef<StorageNode>} storageNode
 * @param {ERef<Marshaller>} marshaller
 * @returns {State}
 */
const initState = (
  zcf,
  directorParamManager,
  debtMint,
  storageNode,
  marshaller,
) => {
  /** For temporary staging of newly minted tokens */
  const { zcfSeat: mintSeat } = zcf.makeEmptySeatKit();
  const { zcfSeat: rewardPoolSeat } = zcf.makeEmptySeatKit();

  const collateralTypes = makeScalarBigMapStore('collateralTypes', {
    durable: true,
  });

  // Non-durable map because param managers aren't durable.
  // In the event they're needed they can be reconstructed from contract terms and off-chain data.
  const vaultParamManagers = makeScalarMap('vaultParamManagers');

  const { metricsPublication, metricsSubscription } = makeMetricsPublisherKit(
    storageNode,
    marshaller,
  );

  Object.assign(ephemera, {
    debtMint,
    directorParamManager,
    marshaller,
    metricsPublication,
    // Subscription can't yet be held durably https://github.com/Agoric/agoric-sdk/issues/4567
    metricsSubscription,
    storageNode,
    vaultParamManagers,
    zcf,
  });

  return {
    collateralTypes,
    managerCounter: 0,
    mintSeat,
    rewardPoolSeat,
    // @ts-expect-error defined in finish()
    shortfallInvitation: undefined,
  };
};

/**
 * @param {Ephemera['directorParamManager']} directorParamManager
 */
const getLiquidationConfig = directorParamManager => ({
  install: directorParamManager.getLiquidationInstall(),
  terms: directorParamManager.getLiquidationTerms(),
});

/**
 *
 * @param {Ephemera['directorParamManager']} govParams
 * @param {VaultManager} vaultManager
 * @param {Installation<unknown>} oldInstall
 * @param {unknown} oldTerms
 */
const watchGovernance = (govParams, vaultManager, oldInstall, oldTerms) => {
  const subscription = govParams.getSubscription();
  void observeIteration(subscription, {
    updateState(_paramUpdate) {
      const { install, terms } = getLiquidationConfig(govParams);
      if (install === oldInstall && keyEQ(terms, oldTerms)) {
        return;
      }
      oldInstall = install;
      oldTerms = terms;
      vaultManager
        .setupLiquidator(install, terms)
        .catch(e => console.error('Failed to setup liquidator', e));
    },
  });
};

/** @param {MethodContext} context */
const finish = async ({ state }) => {
  const { shortfallReporter, shortfallInvitation } =
    await updateShortfallReporter(
      ephemera.zcf.getZoeService(),
      ephemera.directorParamManager,
    );
  ephemera.shortfallReporter = shortfallReporter;
  // @ts-expect-error write once
  state.shortfallInvitation = shortfallInvitation;
};

/**
 * "Director" of the vault factory, overseeing "vault managers".
 *
 * @param {ZCF<GovernanceTerms<{}> & {
 *   ammPublicFacet: AutoswapPublicFacet,
 *   liquidationInstall: Installation<import('./liquidateMinimum.js').start>,
 *   loanTimingParams: {ChargingPeriod: ParamValueTyped<'nat'>, RecordingPeriod: ParamValueTyped<'nat'>},
 *   reservePublicFacet: AssetReservePublicFacet,
 *   timerService: TimerService,
 *   priceAuthority: ERef<PriceAuthority>
 * }>} zcf
 * @param {import('@agoric/governance/src/contractGovernance/typedParamManager').TypedParamManager<import('./params.js').VaultDirectorParams>} directorParamManager
 * @param {ZCFMint<"nat">} debtMint
 */
const makeVaultDirector = defineDurableFarClassKit(
  makeKindHandle('VaultDirector'),
  {
    creator: M.interface('creator', {
      getParamMgrRetriever: M.call().returns(M.remotable()),
      getInvitation: M.call(M.string()).returns(M.promise()),
      getLimitedCreatorFacet: M.call().returns(M.remotable()),
      getGovernedApis: M.call().returns(M.record()),
      getGovernedApiNames: M.call().returns(M.record()),
    }),
    machine: M.interface('machine', {
      addVaultType: M.call(IssuerShape, M.string(), M.record()).returns(
        M.promise(),
      ),
      makeCollectFeesInvitation: M.call().returns(M.promise()),
      getContractGovernor: M.call().returns(M.remotable()),
      updateMetrics: M.call().returns(),
      getRewardAllocation: M.call().returns({ Minted: AmountShape }),
    }),
    public: M.interface('public', {
      getCollateralManager: M.call(BrandShape).returns(M.remotable()),
      getCollaterals: M.call().returns(M.promise()),
      getMetrics: M.call().returns(SubscriberShape),
      makeVaultInvitation: M.call().returns(M.promise()),
      getRunIssuer: M.call().returns(IssuerShape),
      getSubscription: M.call({ collateralBrand: BrandShape }).returns(
        SubscriberShape,
      ),
      getElectorateSubscription: M.call().returns(SubscriberShape),
      getGovernedParams: M.call({ collateralBrand: BrandShape }).returns(
        M.record(),
      ),
      getContractGovernor: M.call().returns(M.remotable()),
      getInvitationAmount: M.call(M.string()).returns(AmountShape),
    }),
  },
  initState,
  {
    creator: {
      getParamMgrRetriever: () =>
        Far('paramManagerRetriever', {
          /** @param {VaultFactoryParamPath} paramPath */
          get: paramPath => {
            if (paramPath.key === 'governedParams') {
              return ephemera.directorParamManager;
            } else if (paramPath.key.collateralBrand) {
              return ephemera.vaultParamManagers.get(
                paramPath.key.collateralBrand,
              );
            } else {
              assert.fail('Unsupported paramPath');
            }
          },
        }),
      /**
       * @param {string} name
       */
      getInvitation(name) {
        return ephemera.directorParamManager.getInternalParamValue(name);
      },
      getLimitedCreatorFacet() {
        return this.facets.machine;
      },
      getGovernedApis() {
        return harden({});
      },
      getGovernedApiNames() {
        return harden({});
      },
    },
    machine: {
      // TODO move this under governance #3924
      /**
       * @param {Issuer<'nat'>} collateralIssuer
       * @param {Keyword} collateralKeyword
       * @param {VaultManagerParamValues} initialParamValues
       */
      async addVaultType(
        collateralIssuer,
        collateralKeyword,
        initialParamValues,
      ) {
        const { state, facets } = this;
        const {
          debtMint,
          vaultParamManagers,
          directorParamManager,
          marshaller,
          storageNode,
          zcf,
        } = ephemera;
        const { collateralTypes, mintSeat, rewardPoolSeat } = state;
        fit(collateralIssuer, M.remotable(), 'collateralIssuer');
        assertKeywordName(collateralKeyword);
        fit(initialParamValues, vaultParamPattern, 'initialParamValues');
        await zcf.saveIssuer(collateralIssuer, collateralKeyword);
        const collateralBrand = zcf.getBrandForIssuer(collateralIssuer);
        // We create only one vault per collateralType.
        !collateralTypes.has(collateralBrand) ||
          Fail`Collateral brand ${q(collateralBrand)} has already been added`;

        const managerStorageNode =
          storageNode &&
          E(storageNode).makeChildNode(`manager${state.managerCounter}`);
        state.managerCounter += 1;

        /** a powerful object; can modify parameters */
        const vaultParamManager = makeVaultParamManager(
          makeStoredPublisherKit(managerStorageNode, marshaller, 'governance'),
          initialParamValues,
        );
        vaultParamManagers.init(collateralBrand, vaultParamManager);

        const { timerService } = zcf.getTerms();
        const startTimeStamp = await E(timerService).getCurrentTimestamp();

        /**
         * We provide an easy way for the vaultManager to add rewards to
         * the rewardPoolSeat, without directly exposing the rewardPoolSeat to them.
         *
         * @type {MintAndReallocate}
         */
        const mintAndReallocate = (toMint, fee, seat, ...otherSeats) => {
          const kept = AmountMath.subtract(toMint, fee);
          debtMint.mintGains(harden({ Minted: toMint }), mintSeat);
          try {
            rewardPoolSeat.incrementBy(
              mintSeat.decrementBy(harden({ Minted: fee })),
            );
            seat.incrementBy(mintSeat.decrementBy(harden({ Minted: kept })));
            zcf.reallocate(rewardPoolSeat, mintSeat, seat, ...otherSeats);
          } catch (e) {
            console.error('mintAndReallocate caught', e);
            mintSeat.clear();
            rewardPoolSeat.clear();
            // Make best efforts to burn the newly minted tokens, for hygiene.
            // That only relies on the internal mint, so it cannot fail without
            // there being much larger problems. There's no risk of tokens being
            // stolen here because the staging for them was already cleared.
            debtMint.burnLosses(harden({ Minted: toMint }), mintSeat);
            throw e;
          } finally {
            // Note that if this assertion may fail because of an error in the
            // try{} block, but that error won't be thrown because this executes
            // before the catch that rethrows it.
            assert(
              Object.values(mintSeat.getCurrentAllocation()).every(a =>
                AmountMath.isEmpty(a),
              ),
              X`Stage should be empty of Minted`,
            );
          }
          facets.machine.updateMetrics();
        };

        /**
         * @param {Amount<'nat'>} toBurn
         * @param {ZCFSeat} seat
         */
        const burnDebt = (toBurn, seat) => {
          debtMint.burnLosses(harden({ Minted: toBurn }), seat);
        };

        const { loanTimingParams } = zcf.getTerms();

        const factoryPowers = Far('vault factory powers', {
          getGovernedParams: () =>
            Far('vault manager param manager', {
              ...vaultParamManager.readonly(),
              /** @type {() => Amount<'nat'>} */
              // @ts-expect-error cast
              getDebtLimit: vaultParamManager.readonly().getDebtLimit,
              getChargingPeriod: () =>
                loanTimingParams[CHARGING_PERIOD_KEY].value,
              getRecordingPeriod: () =>
                loanTimingParams[RECORDING_PERIOD_KEY].value,
            }),
          mintAndReallocate,
          getShortfallReporter: async () => {
            const reporterKit = await updateShortfallReporter(
              zcf.getZoeService(),
              directorParamManager,
              ephemera.shortfallReporter,
              state.shortfallInvitation,
            );
            return reporterKit.shortfallReporter;
          },
          burnDebt,
        });

        const vm = makeVaultManager(
          zcf,
          debtMint,
          collateralBrand,
          zcf.getTerms().priceAuthority,
          factoryPowers,
          timerService,
          startTimeStamp,
          managerStorageNode,
          ephemera.marshaller,
        );
        collateralTypes.init(collateralBrand, vm);
        const { install, terms } = getLiquidationConfig(directorParamManager);
        await vm.setupLiquidator(install, terms);
        watchGovernance(directorParamManager, vm, install, terms);
        facets.machine.updateMetrics();
        return vm;
      },
      makeCollectFeesInvitation() {
        const { state } = this;
        const { debtMint, zcf } = ephemera;
        const { rewardPoolSeat } = state;
        return makeMakeCollectFeesInvitation(
          zcf,
          rewardPoolSeat,
          debtMint.getIssuerRecord().brand,
          'Minted',
        ).makeCollectFeesInvitation();
      },
      getContractGovernor() {
        return ephemera.zcf.getTerms().electionManager;
      },
      updateMetrics() {
        const { state } = this;
        return ephemera.metricsPublication.updateState(
          metricsOf(harden(state)),
        );
      },
      // XXX accessors for tests
      getRewardAllocation() {
        return this.state.rewardPoolSeat.getCurrentAllocation();
      },
    },
    public: {
      /**
       * @param {Brand} brandIn
       */
      getCollateralManager(brandIn) {
        const { state } = this;
        const { collateralTypes } = state;
        collateralTypes.has(brandIn) ||
          Fail`Not a supported collateral type ${brandIn}`;
        /** @type {VaultManager} */
        return collateralTypes.get(brandIn).getPublicFacet();
      },
      /**
       * @deprecated get `collaterals` list from metrics
       */
      async getCollaterals() {
        const { collateralTypes } = this.state;
        // should be collateralTypes.map((vm, brand) => ({
        return harden(
          Promise.all(
            [...collateralTypes.entries()].map(async ([brand, vm]) => {
              const priceQuote = await vm.getCollateralQuote();
              return {
                brand,
                interestRate: vm.getGovernedParams().getInterestRate(),
                liquidationMargin: vm
                  .getGovernedParams()
                  .getLiquidationMargin(),
                stabilityFee: vm.getGovernedParams().getLoanFee(),
                marketPrice: makeRatioFromAmounts(
                  getAmountOut(priceQuote),
                  getAmountIn(priceQuote),
                ),
              };
            }),
          ),
        );
      },
      getMetrics() {
        return ephemera.metricsSubscription;
      },
      /**
       * @deprecated use getCollateralManager and then makeVaultInvitation instead
       *
       * Make a vault in the vaultManager based on the collateral type.
       */
      makeVaultInvitation() {
        const { zcf } = ephemera;

        const { collateralTypes } = this.state;

        /** @param {ZCFSeat} seat */
        const makeVaultHook = async seat => {
          assertProposalShape(seat, {
            give: { Collateral: null },
            want: { Minted: null },
          });
          const {
            give: { Collateral: collateralAmount },
            want: { Minted: requestedAmount },
          } = seat.getProposal();
          const { brand: brandIn } = collateralAmount;
          collateralTypes.has(brandIn) ||
            Fail`Not a supported collateral type ${brandIn}`;

          AmountMath.isGTE(
            requestedAmount,
            ephemera.directorParamManager.getMinInitialDebt(),
          ) ||
            Fail`The request must be for at least ${
              ephemera.directorParamManager.getMinInitialDebt().value
            }. ${requestedAmount.value} is too small`;

          /** @type {VaultManager} */
          const mgr = collateralTypes.get(brandIn);
          return mgr.makeVaultKit(seat);
        };
        return zcf.makeInvitation(makeVaultHook, 'MakeVault');
      },
      getRunIssuer() {
        return ephemera.debtMint.getIssuerRecord().issuer;
      },
      /**
       * subscription for the paramManager for a particular vaultManager
       *
       * @param {{ collateralBrand: Brand }} selector
       */
      getSubscription({ collateralBrand }) {
        return ephemera.vaultParamManagers
          .get(collateralBrand)
          .getSubscription();
      },
      /**
       * subscription for the paramManager for the vaultFactory's electorate
       */
      getElectorateSubscription() {
        return ephemera.directorParamManager.getSubscription();
      },
      /**
       * @param {{ collateralBrand: Brand }} selector
       */
      getGovernedParams({ collateralBrand }) {
        // TODO use named getters of TypedParamManager
        return ephemera.vaultParamManagers.get(collateralBrand).getParams();
      },
      /**
       * @returns {Promise<GovernorPublic>}
       */
      getContractGovernor() {
        // PERF consider caching
        return E(ephemera.zcf.getZoeService()).getPublicFacet(
          ephemera.zcf.getTerms().electionManager,
        );
      },
      /**
       * @param {string} name
       */
      getInvitationAmount(name) {
        return ephemera.directorParamManager.getInvitationAmount(name);
      },
    },
  },
  { finish },
);

harden(makeVaultDirector);
export { makeVaultDirector };
