import { Far } from '@endo/far';
import {
  mapAsyncIterable,
  makeNotifierIterable,
  makeSubscriptionIterable,
} from './iterable.js';
import { makeCosmjsFollower } from './follower-cosmjs.js';
import { makeCastingSpec } from './casting-spec.js';

/**
 * @template T
 * @param {ERef<import('./types').CastingSpec>} spec
 */
const makeSubscriptionFollower = spec => {
  const transform = value =>
    harden({ value, blockHeight: NaN, currentBlockHeight: NaN });
  /** @type {import('./types').Follower<import('./types.js').ValueFollowerElement<T>>} */
  const follower = Far('subscription/notifier follower', {
    getLatestIterable: async () => {
      const { notifier, subscription } = await spec;
      let ai;
      if (notifier) {
        ai = makeNotifierIterable(notifier);
      } else {
        assert(subscription);
        ai = makeSubscriptionIterable(subscription);
      }
      return mapAsyncIterable(ai, transform);
    },

    getEachIterable: async () => {
      const { notifier, subscription } = await spec;
      let ai;
      if (subscription) {
        ai = makeSubscriptionIterable(subscription);
      } else {
        assert(notifier);
        ai = makeNotifierIterable(notifier);
      }
      return mapAsyncIterable(ai, transform);
    },

    getReverseIterable: async () => {
      throw Error(
        'reverse iteration not implemented for subscription follower',
      );
    },
  });
  return follower;
};

/**
 * @template T
 * @param {ERef<import('./types').CastingSpec> | string} specP
 * @param {import('./types').LeaderOrMaker} [leaderOrMaker]
 * @param {import('./types').FollowerOptions} [options]
 * @returns {Promise<import('./follower-cosmjs').ValueFollower<T>>}
 */
export const makeFollower = async (specP, leaderOrMaker, options) => {
  const spec = await makeCastingSpec(specP);
  const { storeName } = spec;
  if (storeName) {
    return makeCosmjsFollower(spec, leaderOrMaker, options);
  }
  return makeSubscriptionFollower(spec);
};
