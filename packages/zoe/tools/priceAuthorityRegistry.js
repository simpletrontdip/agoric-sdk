import { E } from '@endo/eventual-send';
import { makeStore } from '@agoric/store';
import { Fail } from '@agoric/assert';
import { Far } from '@endo/marshal';

/**
 * @typedef {object} Deleter
 * @property {() => void} delete
 */

/**
 * @typedef {object} PriceAuthorityRegistryAdmin
 * @property {(pa: ERef<PriceAuthority>,
 *             brandIn: Brand,
 *             brandOut: Brand,
 *             force?: boolean) => Deleter} registerPriceAuthority Add a unique price authority for a given
 * pair
 */

/**
 * @typedef {object} PriceAuthorityRegistry A price authority that is a facade
 * for other backing price authorities registered for a given asset and price
 * brand
 * @property {PriceAuthority} priceAuthority
 * @property {PriceAuthorityRegistryAdmin} adminFacet
 */

/**
 * @returns {PriceAuthorityRegistry}
 */
export const makePriceAuthorityRegistry = () => {
  /**
   * @typedef {object} PriceAuthorityRecord A record indicating a registered
   * price authority.  We put a box around the priceAuthority to ensure the
   * deleter doesn't delete the wrong thing.
   * @property {ERef<PriceAuthority>} priceAuthority the sub-authority for a
   * given input and output brand pair
   */

  /** @type {Store<Brand, Store<Brand, PriceAuthorityRecord>>} */
  const assetToPriceStore = makeStore('brandIn');

  /**
   * Get the registered price authority for a given input and output pair.
   *
   * @param {Brand} brandIn
   * @param {Brand} brandOut
   * @returns {ERef<PriceAuthority>}
   */
  const paFor = (brandIn, brandOut) => {
    const priceStore = assetToPriceStore.get(brandIn);
    return priceStore.get(brandOut).priceAuthority;
  };

  /**
   * Create a quoteWhen* method for the given condition.
   *
   * @param {'LT' | 'LTE' | 'GTE' | 'GT'} relation
   */
  const makeQuoteWhen = relation =>
    /**
     * Return a quote when relation is true of the arguments.
     *
     * @param {Amount<'nat'>} amountIn monitor the amountOut corresponding to this amountIn
     * @param {Amount<'nat'>} amountOutLimit the value to compare with the monitored amountOut
     * @returns {Promise<PriceQuote>} resolve with a quote when `amountOut
     * relation amountOutLimit` is true
     */
    async function quoteWhenRelation(amountIn, amountOutLimit) {
      const pa = paFor(amountIn.brand, amountOutLimit.brand);
      return E(pa)[`quoteWhen${relation}`](amountIn, amountOutLimit);
    };

  /**
   * Create a mutableQuoteWhen* method for the given condition.
   *
   * @param {'LT' | 'LTE' | 'GTE' | 'GT'} relation
   */
  const makeMutableQuoteWhen = relation =>
    /**
     * Return a mutable quote when relation is true of the arguments.
     *
     * @param {Amount} amountIn monitor the amountOut corresponding to this amountIn
     * @param {Amount} amountOutLimit the value to compare with the monitored amountOut
     * @returns {Promise<MutableQuote>} resolve with a quote when `amountOut
     * relation amountOutLimit` is true
     */
    async function mutableQuoteWhenRelation(amountIn, amountOutLimit) {
      const pa = paFor(amountIn.brand, amountOutLimit.brand);
      return E(pa)[`mutableQuoteWhen${relation}`](amountIn, amountOutLimit);
    };

  /**
   * This PriceAuthority is just a wrapper for multiple registered
   * PriceAuthorities.
   *
   * @type {PriceAuthority}
   */
  const priceAuthority = Far('fake price authority', {
    async getQuoteIssuer(brandIn, brandOut) {
      return E(paFor(brandIn, brandOut)).getQuoteIssuer(brandIn, brandOut);
    },
    async getTimerService(brandIn, brandOut) {
      return E(paFor(brandIn, brandOut)).getTimerService(brandIn, brandOut);
    },
    async quoteGiven(amountIn, brandOut) {
      return E(paFor(amountIn.brand, brandOut)).quoteGiven(amountIn, brandOut);
    },
    async quoteWanted(brandIn, amountOut) {
      return E(paFor(brandIn, amountOut.brand)).quoteWanted(brandIn, amountOut);
    },
    async makeQuoteNotifier(amountIn, brandOut) {
      return E(paFor(amountIn.brand, brandOut)).makeQuoteNotifier(
        amountIn,
        brandOut,
      );
    },
    async quoteAtTime(deadline, amountIn, brandOut) {
      return E(paFor(amountIn.brand, brandOut)).quoteAtTime(
        deadline,
        amountIn,
        brandOut,
      );
    },
    quoteWhenLT: makeQuoteWhen('LT'),
    quoteWhenLTE: makeQuoteWhen('LTE'),
    quoteWhenGTE: makeQuoteWhen('GTE'),
    quoteWhenGT: makeQuoteWhen('GT'),
    mutableQuoteWhenLT: makeMutableQuoteWhen('LT'),
    mutableQuoteWhenLTE: makeMutableQuoteWhen('LTE'),
    mutableQuoteWhenGTE: makeMutableQuoteWhen('GTE'),
    mutableQuoteWhenGT: makeMutableQuoteWhen('GT'),
  });

  /** @type {PriceAuthorityRegistryAdmin} */
  const adminFacet = Far('price authority admin facet', {
    registerPriceAuthority(pa, brandIn, brandOut, force = false) {
      /** @type {Store<Brand, PriceAuthorityRecord>} */
      let priceStore;
      if (assetToPriceStore.has(brandIn)) {
        priceStore = assetToPriceStore.get(brandIn);
      } else {
        priceStore = makeStore('brandOut');
        assetToPriceStore.init(brandIn, priceStore);
      }

      // Put a box around the authority so that we can be ensured the deleter
      // won't delete the wrong thing.
      const record = {
        priceAuthority: pa,
      };

      // Set up the record.
      if (force && priceStore.has(brandOut)) {
        priceStore.set(brandOut, harden(record));
      } else {
        priceStore.init(brandOut, harden(record));
      }

      return Far('deleter', {
        delete() {
          (priceStore.has(brandOut) && priceStore.get(brandOut) === record) ||
            Fail`Price authority already dropped`;
          priceStore.delete(brandOut);
        },
      });
    },
  });

  return harden({
    priceAuthority,
    adminFacet,
  });
};
