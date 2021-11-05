// @ts-check

import { assert, details as X } from '@agoric/assert';
import { makeLegacyWeakMap, makeLegacyMap } from '@agoric/store';
import { E } from '@agoric/eventual-send';
import { Far } from '@agoric/marshal';
import { assertProposalShape } from '@agoric/zoe/src/contractSupport/index.js';
import { makeSubscriptionKit } from '@agoric/notifier';

import '@agoric/vats/exported.js';
import '@agoric/swingset-vat/src/vats/network/types.js';
import '@agoric/zoe/exported.js';

import '../exported.js';
import { ICS20TransferProtocol } from './ics20.js';
import { makeCourierMaker, getCourierPK } from './courier.js';

const DEFAULT_TRANSFER_PROTOCOL = ICS20TransferProtocol;

const TRANSFER_PROPOSAL_SHAPE = {
  give: {
    Transfer: null,
  },
};

/**
 * Make a Pegasus public API.
 *
 * @param {ContractFacet} zcf the Zoe Contract Facet
 * @param {ERef<BoardDepositFacet>} board where to find depositFacets by boardID
 * @param {ERef<NameHub>} namesByAddress where to find depositFacets by bech32
 */
const makePegasus = (zcf, board, namesByAddress) => {
  /**
   * @typedef {Object} LocalDenomState
   * @property {Store<Denom, PromiseRecord<Courier>>} remoteDenomToCourierPK
   * @property {IterationObserver<Denom>} remoteDenomPublication
   * @property {Subscription<Denom>} remoteDenomSubscription
   * @property {number} lastDenomNonce
   */

  let lastLocalIssuerNonce = 0;
  /**
   * Create a new issuer keyword (based on Local + nonce)
   *
   * @returns {string}
   */
  const createLocalIssuerKeyword = () => {
    lastLocalIssuerNonce += 1;
    return `Local${lastLocalIssuerNonce}`;
  };

  /**
   * @type {LegacyWeakMap<Peg, LocalDenomState>}
   */
  const pegToDenomState = makeLegacyWeakMap('Peg');

  /**
   * Create a fresh Peg associated with a descriptor.
   *
   * @typedef {Object} PegasusDescriptor
   * @property {Brand} localBrand
   * @property {Denom} remoteDenom
   * @property {string} allegedName
   *
   * @param {LocalDenomState} state
   * @param {PegasusDescriptor} desc
   * @returns {Peg}
   */
  const makePeg = (state, desc) => {
    /** @type {Peg} */
    const peg = Far('peg', {
      getAllegedName() {
        return desc.allegedName;
      },
      getLocalBrand() {
        return desc.localBrand;
      },
      getRemoteDenom() {
        return desc.remoteDenom;
      },
    });

    pegToDenomState.init(peg, state);
    return peg;
  };

  /**
   * @param {Object} param0
   * @param {ReturnType<typeof makeCourierMaker>} param0.makeCourier
   * @param {LocalDenomState} param0.localDenomState
   * @param {ERef<TransferProtocol>} param0.transferProtocol
   * @returns {PegasusConnectionActions}
   */
  const makePegasusConnectionActions = ({
    makeCourier,
    localDenomState,
    transferProtocol,
  }) => {
    /** @type {PegasusConnectionActions} */
    const pegasusConnectionActions = {
      async rejectStuckTransfers(remoteDenom) {
        const { remoteDenomToCourierPK } = localDenomState;

        const { reject, promise } = remoteDenomToCourierPK.get(remoteDenom);
        promise.catch(() => {});
        reject(assert.error(X`${remoteDenom} is temporarily unavailable`));

        // Allow new transfers to be initiated.
        remoteDenomToCourierPK.delete(remoteDenom);
      },
      async pegRemote(
        allegedName,
        remoteDenom,
        assetKind = undefined,
        displayInfo = undefined,
      ) {
        const { remoteDenomToCourierPK } = localDenomState;

        // Create the issuer for the local erights corresponding to the remote values.
        const localKeyword = createLocalIssuerKeyword();
        const zcfMint = await zcf.makeZCFMint(
          localKeyword,
          assetKind,
          displayInfo,
        );
        const { brand: localBrand } = zcfMint.getIssuerRecord();

        // Describe how to retain/redeem pegged shadow erights.
        const courier = makeCourier({
          zcf,
          localBrand,
          board,
          namesByAddress,
          remoteDenom,
          retain: (zcfSeat, amounts) => zcfMint.burnLosses(amounts, zcfSeat),
          redeem: (zcfSeat, amounts) => {
            zcfMint.mintGains(amounts, zcfSeat);
          },
          transferProtocol,
        });

        const courierPK = getCourierPK(remoteDenom, remoteDenomToCourierPK);
        courierPK.resolve(courier);

        return makePeg(localDenomState, {
          localBrand,
          remoteDenom,
          allegedName,
        });
      },

      async pegLocal(allegedName, localIssuer) {
        // We need the last nonce for our denom name.
        localDenomState.lastDenomNonce += 1;
        const remoteDenom = `pegasus${localDenomState.lastDenomNonce}`;

        // Create a seat in which to keep our denomination.
        const { zcfSeat: poolSeat } = zcf.makeEmptySeatKit();

        // Ensure the issuer can be used in Zoe offers.
        const localKeyword = createLocalIssuerKeyword();
        const { brand: localBrand } = await zcf.saveIssuer(
          localIssuer,
          localKeyword,
        );

        /**
         * Transfer amount (of localBrand) from loser to winner seats.
         *
         * @param {Amount} amount amount to transfer
         * @param {Keyword} loserKeyword the keyword to take from the loser
         * @param {ZCFSeat} loser seat to transfer from
         * @param {Keyword} winnerKeyword the keyword to give to the winner
         * @param {ZCFSeat} winner seat to transfer to
         */
        const transferAmountFrom = (
          amount,
          loserKeyword,
          loser,
          winnerKeyword,
          winner,
        ) => {
          // Transfer the amount to our backing seat.
          loser.decrementBy({ [loserKeyword]: amount });
          winner.incrementBy({ [winnerKeyword]: amount });
          zcf.reallocate(loser, winner);
        };

        // Describe how to retain/redeem real local erights.
        const courier = makeCourier({
          zcf,
          board,
          namesByAddress,
          remoteDenom,
          localBrand,
          retain: (transferSeat, amounts) =>
            transferAmountFrom(
              amounts.Transfer,
              'Transfer',
              transferSeat,
              'Pool',
              poolSeat,
            ),
          redeem: (transferSeat, amounts) =>
            transferAmountFrom(
              amounts.Transfer,
              'Pool',
              poolSeat,
              'Transfer',
              transferSeat,
            ),
          transferProtocol,
        });

        const { remoteDenomToCourierPK } = localDenomState;

        const courierPK = getCourierPK(remoteDenom, remoteDenomToCourierPK);
        courierPK.resolve(courier);

        return makePeg(localDenomState, {
          localBrand,
          remoteDenom,
          allegedName,
        });
      },
    };
    return Far('pegasusConnectionActions', pegasusConnectionActions);
  };

  return Far('pegasus', {
    /**
     * Return a handler that can be used with the Network API.
     *
     * @param {ERef<TransferProtocol>} [transferProtocol=DEFAULT_TRANSFER_PROTOCOL]
     * @returns {PegasusConnectionKit}
     */
    makePegasusConnectionKit(transferProtocol = DEFAULT_TRANSFER_PROTOCOL) {
      /**
       * @type {WeakStore<Connection, LocalDenomState>}
       */
      // Legacy because the value contains a JS Set
      const connectionToLocalDenomState = makeLegacyWeakMap('Connection');

      /**
       * @type {SubscriptionRecord<PegasusConnectionSubscription>}
       */
      const {
        subscription: connectionSubscription,
        publication: connectionPublication,
      } = makeSubscriptionKit();

      /** @type {ConnectionHandler} */
      const handler = {
        async onOpen(c, localAddr, remoteAddr) {
          // Register C with the table of Peg receivers.
          const {
            subscription: remoteDenomSubscription,
            publication: remoteDenomPublication,
          } = makeSubscriptionKit();
          const remoteDenomToCourierPK = makeLegacyMap('Denomination');

          /** @type {LocalDenomState} */
          const localDenomState = {
            remoteDenomToCourierPK,
            lastDenomNonce: 0,
            remoteDenomPublication,
            remoteDenomSubscription,
          };

          // The courier is the only thing that we use to send messages to C.
          const makeCourier = makeCourierMaker(c);
          const actions = makePegasusConnectionActions({
            localDenomState,
            makeCourier,
            transferProtocol,
          });

          connectionToLocalDenomState.init(c, localDenomState);

          /** @type {PegasusConnectionSubscription} */
          const subData = harden({
            localAddr,
            remoteAddr,
            actions,
            remoteDenomSubscription,
          });
          connectionPublication.updateState(subData);
        },
        async onReceive(c, packetBytes) {
          const doReceive = async () => {
            // Dispatch the packet to the appropriate Peg for this connection.
            const parts = await E(transferProtocol).parseTransferPacket(
              packetBytes,
            );

            const { remoteDenom } = parts;
            assert.typeof(remoteDenom, 'string');

            const {
              remoteDenomToCourierPK,
              remoteDenomPublication,
            } = connectionToLocalDenomState.get(c);

            if (!remoteDenomToCourierPK.has(remoteDenom)) {
              // This is the first time we've heard of this denomination.
              remoteDenomPublication.updateState(remoteDenom);
            }

            // Wait for the courier to be instantiated.
            const courierPK = getCourierPK(remoteDenom, remoteDenomToCourierPK);
            const { receive } = await courierPK.promise;
            return receive(parts);
          };

          return doReceive().catch(error =>
            E(transferProtocol).makeTransferPacketAck(false, error),
          );
        },
        async onClose(c) {
          // Unregister C.  Pending transfers will be rejected by the Network API.
          const { remoteDenomPublication } = connectionToLocalDenomState.get(c);
          connectionToLocalDenomState.delete(c);
          remoteDenomPublication.fail(
            assert.error(X`pegasusConnectionHandler closed`),
          );
        },
      };

      return harden({
        handler: Far('pegasusConnectionHandler', handler),
        subscription: connectionSubscription,
      });
    },

    getLocalIssuer(localBrand) {
      return zcf.getIssuerForBrand(localBrand);
    },

    /**
     * Create a Zoe invitation to transfer assets over network to a deposit address.
     *
     * @param {ERef<Peg>} pegP the peg over which to transfer
     * @param {DepositAddress} depositAddress the remote receiver's address
     * @returns {Promise<Invitation>} to transfer, make an offer of { give: { Transfer: pegAmount } } to this invitation
     */
    async makeInvitationToTransfer(pegP, depositAddress) {
      // Verify the peg.
      const peg = await pegP;
      const denomState = pegToDenomState.get(peg);

      // Get details from the peg.
      const remoteDenom = await E(peg).getRemoteDenom();
      const { remoteDenomToCourierPK } = denomState;

      const courierPK = getCourierPK(remoteDenom, remoteDenomToCourierPK);
      const { send } = await courierPK.promise;

      /**
       * Attempt the transfer, returning a refund if failed.
       *
       * @type {OfferHandler}
       */
      const offerHandler = zcfSeat => {
        assertProposalShape(zcfSeat, TRANSFER_PROPOSAL_SHAPE);
        send(zcfSeat, depositAddress);
      };

      return zcf.makeInvitation(
        offerHandler,
        `pegasus ${remoteDenom} transfer`,
      );
    },
  });
};

/**
 * @typedef {ReturnType<typeof makePegasus>} Pegasus
 */

/**
 * @type {ContractStartFn}
 */
const start = zcf => {
  const { board, namesByAddress } = zcf.getTerms();

  return {
    publicFacet: makePegasus(zcf, board, namesByAddress),
  };
};

harden(start);
harden(makePegasus);
export { start, makePegasus };
