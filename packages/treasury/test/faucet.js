// @ts-check

import { Far } from '@agoric/marshal';
import { assertProposalShape } from '@agoric/zoe/src/contractSupport';
import { LOW_FEE, SHORT_EXP } from '@agoric/zoe/src/constants';

// A Faucet providing RUN so we can provide initial liquidity to the AMM so the
// Treasury can reliably liquidate.

/** @type {ContractStartFn} */
export async function start(zcf, privateArgs) {
  const { feeMintAccess } = privateArgs;
  const runMint = await zcf.registerFeeMint('RUN', feeMintAccess);

  function makeFaucetInvitation() {
    /** @param {ZCFSeat} seat */
    async function faucetHook(seat) {
      assertProposalShape(seat, { want: { RUN: null } });

      const {
        want: { RUN: runAmount },
      } = seat.getProposal();
      runMint.mintGains({ RUN: runAmount }, seat);
      seat.exit();
      return `success ${runAmount.value}`;
    }

    return zcf.makeInvitation(
      faucetHook,
      'provide RUN',
      undefined,
      LOW_FEE,
      SHORT_EXP,
    );
  }

  const creatorFacet = Far('faucetInvitationMaker', { makeFaucetInvitation });
  return harden({ creatorFacet });
}
