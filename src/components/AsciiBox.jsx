// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
const SINGLE = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', ml: '├', mr: '┤' };
const DOUBLE = { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', ml: '╠', mr: '╣' };

const WIDTH = 72;

export function AsciiBox({ title, children, variant = 'single' }) {
  const ch = variant === 'double' ? DOUBLE : SINGLE;
  const inner = WIDTH - 2; // space inside borders

  const titleStr = title ? ` ${title} ` : '';
  const dashCount = inner - titleStr.length;
  const leftDash = Math.floor(dashCount / 2);
  const rightDash = dashCount - leftDash;

  const topLine = ch.tl + ch.h.repeat(leftDash) + titleStr + ch.h.repeat(rightDash) + ch.tr;
  const botLine = ch.bl + ch.h.repeat(inner) + ch.br;

  return (
    <div className={`ascii-box${variant === 'double' ? ' ascii-box--double' : ''}`}>
      <div>{topLine}</div>
      <div className="ascii-box__content">{children}</div>
      <div>{botLine}</div>
    </div>
  );
}

export function AsciiLine({ char = '─', variant = 'single', left, right }) {
  const ch = variant === 'double' ? DOUBLE : SINGLE;
  const l = left || ch.ml;
  const r = right || ch.mr;
  return <div>{l + char.repeat(WIDTH - 2) + r}</div>;
}

export function AsciiRow({ children }) {
  return (
    <div className="ascii-box__row">
      <span>│</span>
      <span className="ascii-box__cell">{children}</span>
      <span>│</span>
    </div>
  );
}
