import assert from "node:assert/strict";
import test from "node:test";
import {
  isPromoQaTask,
  parseShopifyEditorUrl,
} from "../supabase/functions/_shared/asana.ts";
import {
  applyDeterministicGuards,
  collectBannerBlocks,
  matchExpectedBanners,
  urlsEquivalent,
} from "../supabase/functions/_shared/verify.ts";

test("recognizes intended QA task names", () => {
  assert.equal(isPromoQaTask({ name: "Banner Upload QA" }), true);
  assert.equal(isPromoQaTask({ name: "Promo Banner QA" }), true);
  assert.equal(isPromoQaTask({ name: "QA - homepage banner" }), true);
  assert.equal(isPromoQaTask({ name: "Product copy QA" }), false);
});

test("parses Shopify editor target and HTML escaped query", () => {
  const target = parseShopifyEditorUrl(
    "https://admin.shopify.com/store/example-store/themes/123456/editor?block=select_abc&amp;section=template--1__hero",
  );
  assert.deepEqual(target, {
    url:
      "https://admin.shopify.com/store/example-store/themes/123456/editor?block=select_abc&section=template--1__hero",
    storeSlug: "example-store",
    shopDomain: "example-store.myshopify.com",
    themeId: "123456",
    sectionHint: "template--1__hero",
    blockHint: "select_abc",
  });
});

test("matches a scheduled banner and enforces exact values", () => {
  const template = {
    sections: {
      hero: {
        type: "customizer__hero-slider",
        blocks: {
          select_sale: {
            type: "select",
            settings: {
              link: "https://shop.test/discount/SUMMER20?redirect=%2Fcollections%2Fall",
              active_start_date: "2026-07-22",
              active_end_date: "2026-07-23",
            },
          },
        },
      },
    },
  };
  const expected = [{
    label: "First banner",
    promo_link: "https://shop.test/discount/SUMMER20?redirect=/collections/all",
    start_date: "2026-07-22",
    end_date: "2026-07-23",
    copy: null,
  }];

  const blocks = collectBannerBlocks(template, "template--1__hero");
  const matches = matchExpectedBanners(expected, blocks, "select_sale");
  const guarded = applyDeterministicGuards({
    passed: true,
    confidence: 0.98,
    summary: "Matches",
    warnings: [],
    banners: [{
      label: "First banner",
      matched_block_id: "select_sale",
      start_field: "active_start_date",
      end_field: "active_end_date",
      link_field: "link",
      found_start: "2026-07-22",
      found_end: "2026-07-23",
      found_link: expected[0].promo_link,
      ok: true,
      issues: [],
    }],
  }, matches, "123", "123");

  assert.equal(blocks.length, 1);
  assert.equal(matches[0].block?.blockId, "select_sale");
  assert.equal(guarded.passed, true);
  assert.equal(guarded.banners[0].ok, true);
});

test("fails when Claude maps an incorrect end date", () => {
  const expected = {
    label: "Sale",
    promo_link: "https://shop.test/discount/SAVE",
    start_date: "2026-07-22",
    end_date: "2026-07-24",
    copy: null,
  };
  const match = {
    expected,
    matchedBy: "link",
    matchScore: 1,
    block: {
      sectionId: "hero",
      sectionType: "hero",
      blockId: "sale",
      blockType: "slide",
      disabled: false,
      settings: {
        link: expected.promo_link,
        starts: "2026-07-22",
        ends: "2026-07-23",
      },
    },
  };
  const guarded = applyDeterministicGuards({
    passed: true,
    confidence: 1,
    summary: "Looks fine",
    warnings: [],
    banners: [{
      label: "Sale",
      matched_block_id: "sale",
      start_field: "starts",
      end_field: "ends",
      link_field: "link",
      found_start: "2026-07-22",
      found_end: "2026-07-23",
      found_link: expected.promo_link,
      ok: true,
      issues: [],
    }],
  }, [match], "123", "456");

  assert.equal(guarded.passed, false);
  assert.match(guarded.banners[0].issues.join(" "), /End date mismatch/);
  assert.match(guarded.warnings.join(" "), /not the published theme/);
});

test("normalizes encoded discount URLs", () => {
  assert.equal(
    urlsEquivalent(
      "https://shop.test/discount/FLASH20%20Sitewide?redirect=/collections/all-products",
      "https://shop.test/discount/FLASH20 Sitewide?redirect=%2Fcollections%2Fall-products",
    ),
    true,
  );
});

test("treats Shopify smart collection links as equivalent to storefront URLs", () => {
  assert.equal(
    urlsEquivalent(
      "https://classiccaladiums.com/collections/caladium_varieties",
      "shopify://collections/caladium_varieties",
    ),
    true,
  );
});
