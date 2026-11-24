import type { TitleSprite } from '../lib/types';

/**
 * The sprite part of a 91porn title: each `<i>` is painted with
 * `background-color: currentColor` + `mask-image` so the sprite PNG carves out
 * the glyphs and the title inherits the theme text color, exactly as the
 * upstream site renders it. Render next to the (optional) text badge.
 */
export function TitleSprites({ sprites }: { sprites: TitleSprite[] }) {
  return (
    <>
      {sprites.map((s, i) => (
        <i
          key={i}
          className="title-sprite"
          style={{
            width: s.width,
            maskImage: `url(${s.url})`,
            WebkitMaskImage: `url(${s.url})`,
          }}
        />
      ))}
    </>
  );
}
