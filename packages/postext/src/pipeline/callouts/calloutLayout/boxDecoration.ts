// A box's decoration in paint order: its shape and border, background,
// stripe and icon (#1278: split out of layoutCallout.ts).
import { isCornerRadii, cornerRadiiPx, type ShapeBorder, borderSidesPx, SHAPE_SIDES, normalizeBoxStyle, uniformRadius, boxOutline } from '../../../design/boxShape.js';
import { createBoundingBox, type VDTDesignBlock } from '../../../vdt.js';
import { resolvedCodeStyle } from '../../../defaults/text/codeStyle.js';
import { buildIconBlock } from './icons.js';
import type { CalloutLayoutInput } from './inputs.js';
import type { ResolvedCalloutStyleConfig } from '../../../types/boxes/callouts.js';
import type { BlockMeasureContext } from '../../blocks/measureContentBlock/types.js';
import type { Dimension } from '../../../types.js';
import type { CalloutState } from './layoutCalloutState.js';

/** What createBoxDecoration takes from the pass. */
export interface BoxDecorationDeps {
  input: CalloutLayoutInput;
  style: ResolvedCalloutStyleConfig;
  ctx: BlockMeasureContext;
  px: (d: Dimension) => number;
  padR: number;
  padL: number;
  stripeOn: boolean;
  stripeW: number;
  sideStripe: boolean;
  stripeLeft: boolean;
  topStripe: boolean;
  hasIcon: boolean;
  iconSize: number;
  iconBoxW: number;
  cornerIcon: boolean;
  cornerRight: boolean;
  iconColumn: number;
  cornerIconW: number;
  innerX: number;
  innerTop: number;
  boxWidth: number;
  innerWidth: number;
  overlayBlocks: VDTDesignBlock[];
  groupRules: VDTDesignBlock[];
  highlights: { y: number; height: number; kind?: import('../../../types.js').CodeLineKind; highlight?: boolean }[];
  contentBottom: number;
  boxHeight: number;
  boxState: CalloutState;
}

/** A colour darker than mid grey (relative luminance, sRGB). */
function isDarkHex(hex: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return false;
  const lin = (c: string) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(m[1]!) + 0.7152 * lin(m[2]!) + 0.0722 * lin(m[3]!) < 0.18;
}

export function createBoxDecoration(deps: BoxDecorationDeps) {
  const {
    input, style, ctx, px, padR, padL, stripeOn, stripeW, sideStripe, stripeLeft, topStripe, hasIcon,
    iconSize, iconBoxW, cornerIcon, cornerRight, iconColumn, cornerIconW, innerX, innerTop, boxWidth,
    innerWidth, overlayBlocks, groupRules, highlights, contentBottom, boxHeight, boxState
  } = deps;
  // --- Box decoration (paint order: background, stripe, icon, title) ---------
  const borderOn = style.border.enabled;
  // Corners of their own and a border per side (#1059); a style with one
  // radius and one border paints as it always has.
  const shaped = isCornerRadii(style.borderRadius) || style.border.sides !== undefined;
  const radii = cornerRadiiPx(style.borderRadius, px);
  const sides: ShapeBorder | undefined = style.border.sides
    ? borderSidesPx({ enabled: borderOn, color: style.border.color, width: style.border.width }, style.border.sides, px)
    : undefined;
  const boxShapeAt = overlayBlocks.length;
  if (style.backgroundEnabled || borderOn || (sides && SHAPE_SIDES.some((side) => sides[side]))) {
    overlayBlocks.push({
      kind: 'box',
      bbox: createBoundingBox(0, 0, boxWidth, boxHeight),
      box: shaped
        ? normalizeBoxStyle({
            backgroundColor: style.backgroundEnabled ? style.background.hex : undefined,
            borderColor: borderOn ? style.border.color.hex : undefined,
            borderWidthPx: borderOn ? px(style.border.width) : 0,
            borderRadiusPx: 0,
            borderRadiiPx: radii,
            ...(sides ? { borderSides: sides } : {}),
          })
        : {
            backgroundColor: style.backgroundEnabled ? style.background.hex : undefined,
            borderColor: borderOn ? style.border.color.hex : undefined,
            borderWidthPx: borderOn ? px(style.border.width) : 0,
            borderRadiusPx: px(uniformRadius(style.borderRadius)!),
          },
    });
  }
  const boxPainted = overlayBlocks.length > boxShapeAt;
  // The highlighted lines of a listing (#624): a band across the inner
  // area and its padding, under the text.
  if (highlights.length > 0) {
    const cs = resolvedCodeStyle(input.resolved);
    const tint = cs.highlightBackground.hex;
    // A line marked by kind (CORE-230) takes its kind's band and rule;
    // a kind with no band leaves a highlighted line its highlight tint.
    const ruleW = px({ value: 1.5, unit: 'pt' });
    // On a dark ground (a terminal's) a kind's pale band would hide the light
    // text: the kind keeps its rule and prefix, without the band.
    // The ground is the box's own background, else what it sits on.
    const ground = style.backgroundEnabled ? style.background.hex : input.ground;
    const dark = ground !== undefined && isDarkHex(ground);
    for (const h of highlights) {
      const look = h.kind ? cs.lineKinds[h.kind] : undefined;
      const band = (dark && look?.background ? undefined : look?.background?.hex) ?? (h.highlight ? tint : undefined);
      const x = innerX - padL;
      if (band) {
        overlayBlocks.push({
          kind: 'box',
          bbox: createBoundingBox(x, h.y, innerWidth + padL + padR, h.height),
          box: { backgroundColor: band, borderWidthPx: 0, borderRadiusPx: 0 },
        });
      }
      if (look?.marker) {
        overlayBlocks.push({
          kind: 'box',
          bbox: createBoundingBox(x, h.y, ruleW, h.height),
          box: { backgroundColor: look.marker.hex, borderWidthPx: 0, borderRadiusPx: 0 },
        });
      }
    }
  }
  boxState.stripeBlock = undefined;
  if (stripeOn) {
    const stripeBox = topStripe
      ? createBoundingBox(0, 0, boxWidth, stripeW)
      : stripeLeft
        ? createBoundingBox(0, 0, stripeW, boxHeight)
        : createBoundingBox(boxWidth - stripeW, 0, stripeW, boxHeight);
    // On a rounded frame the stripe follows the corners: it is clipped to
    // the frame's rounded rectangle (the radius clamped as the frame's is),
    // so its square ends never stick out past the background and border.
    // Corners of their own (#1059) are clamped as the frame's outline
    // clamps them; a joined tab sets the clip again below.
    const clipRadii: [number, number, number, number] = shaped
      ? boxOutline(createBoundingBox(0, 0, boxWidth, boxHeight), radii).vertices.map((v) => v.r) as [number, number, number, number]
      : (() => {
          const frameRadius = Math.max(0, Math.min(px(uniformRadius(style.borderRadius)!), boxWidth / 2, boxHeight / 2));
          return [frameRadius, frameRadius, frameRadius, frameRadius];
        })();
    boxState.stripeBlock = {
      kind: 'box',
      bbox: stripeBox,
      box: { backgroundColor: style.stripe.color.hex, borderWidthPx: 0, borderRadiusPx: 0 },
      ...(clipRadii.some((r) => r > 0)
        ? { clip: { x: 0, y: 0, width: boxWidth, height: boxHeight, radii: clipRadii } }
        : {}),
    };
    overlayBlocks.push(boxState.stripeBlock);
  }
  boxState.iconFileId = undefined;
  boxState.iconFormat = undefined;
  if (hasIcon) {
    // Over a side stripe the icon is centred on the stripe; otherwise it
    // sits in its own column left of the content.
    // A corner badge hangs on its corner half past the border, flush with
    // the top edge.
    const iconX = cornerIcon
      ? (cornerRight ? boxWidth - cornerIconW / 2 : -cornerIconW / 2)
      : sideStripe
        ? (stripeLeft ? (stripeW - iconSize) / 2 : boxWidth - stripeW + (stripeW - iconSize) / 2)
        : innerX - iconColumn;
    const iconY = cornerIcon
      ? 0
      : style.icon.align === 'center'
        ? innerTop + (contentBottom - innerTop - iconSize) / 2
        : innerTop;
    const built = buildIconBlock(style.icon, iconX, iconY, iconSize, ctx, iconBoxW, px);
    if (built) {
      overlayBlocks.push(built.block);
      boxState.iconFileId = built.fileId;
      boxState.iconFormat = built.format;
    }
  }
  overlayBlocks.push(...groupRules);
  return {
    borderOn, radii, sides, boxShapeAt, boxPainted
  };
}
