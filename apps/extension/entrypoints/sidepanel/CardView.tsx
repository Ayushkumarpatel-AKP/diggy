/**
 * CardView — renders a `RichCard` (from `@diggy/shared`) as a pen-sketch card
 * inside a chat message.
 *
 * Layout (compact, tuned for the ~400px side panel):
 *   - optional 16:9 media area (thumbnail / snapshot), with a ▶ overlay for
 *     `kind:'video'`,
 *   - a favicon + title row with an external-link affordance,
 *   - subtitle + `badge` pill,
 *   - `details` as label / value lines,
 *   - a wrap row of action buttons.
 *
 * Buttons map `CardActionKind`: `link` opens the URL in a new tab via the
 * extension tabs API; `message` / `command` are handed to `onAction`.
 *
 * Images degrade gracefully: a remote `url` that fails `onError` falls back to
 * `image.dataUrl`, and when that is missing too the media area is hidden — a
 * broken image is never shown.
 */
import { useState } from 'react';
import { cn, SketchBadge, SketchButton, SketchCard } from '@diggy/ui';
import type { AccentName } from '@diggy/ui';
import type { CardAction, CardImage, CardKind, RichCard } from '@diggy/shared';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Open a URL in a new tab (extension tabs API, with a `window.open` fallback). */
function openInNewTab(url: string): void {
  try {
    void browser.tabs.create({ url });
  } catch {
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      /* blocked — nothing else to do */
    }
  }
}

/** `CardAction.variant` → one of the sketch button variants + accent. */
function buttonLook(
  variant: CardAction['variant'],
): { variant: 'accent' | 'ghost' | 'paper'; accent: AccentName } {
  if (variant === 'primary') return { variant: 'accent', accent: 'sky' };
  if (variant === 'danger') return { variant: 'accent', accent: 'red' };
  if (variant === 'ghost') return { variant: 'ghost', accent: 'sky' };
  return { variant: 'paper', accent: 'sky' };
}

/* ------------------------------------------------------------------ *
 * Media
 * ------------------------------------------------------------------ */

function CardMedia({ image, kind }: { image: CardImage; kind: CardKind }): JSX.Element | null {
  const initialSrc = image.url || image.dataUrl || '';
  const [src, setSrc] = useState<string>(initialSrc);
  const [broken, setBroken] = useState<boolean>(initialSrc.length === 0);

  if (broken || !src) return null;

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-sketch-sm border-2 border-ink/20 bg-paper-100">
      <img
        src={src}
        alt={image.alt ?? ''}
        loading="lazy"
        className="h-full w-full object-cover"
        onError={() => {
          // Remote image blocked/failed → try the data URL, else hide entirely.
          if (image.dataUrl && src !== image.dataUrl) setSrc(image.dataUrl);
          else setBroken(true);
        }}
      />
      {kind === 'video' ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 grid place-items-center"
        >
          <span className="grid h-10 w-10 place-items-center rounded-full border-2 border-ink/80 bg-paper/85 text-base text-ink shadow-sketch-soft">
            ▶
          </span>
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * CardView
 * ------------------------------------------------------------------ */

export function CardView({
  card,
  onAction,
}: {
  card: RichCard;
  onAction?: (action: CardAction) => void;
}): JSX.Element {
  const [faviconBroken, setFaviconBroken] = useState(false);
  const url = card.url;
  const actions = card.actions ?? [];

  const handleAction = (action: CardAction): void => {
    if (action.kind === 'link') {
      openInNewTab(action.value);
      return;
    }
    onAction?.(action);
  };

  const titleRow = (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      {card.faviconUrl && !faviconBroken ? (
        <img
          src={card.faviconUrl}
          alt=""
          width={16}
          height={16}
          className="h-4 w-4 shrink-0 rounded-sm object-contain"
          onError={() => setFaviconBroken(true)}
        />
      ) : (
        <span
          aria-hidden="true"
          className="grid h-4 w-4 shrink-0 place-items-center rounded-sm bg-paper-200 text-[9px] text-ink-400"
        >
          ◆
        </span>
      )}
      <span className="truncate font-sketch text-sm font-semibold text-ink" title={card.title}>
        {card.title}
      </span>
      {url ? (
        <span aria-hidden="true" className="shrink-0 text-xs text-ink-400">
          ↗
        </span>
      ) : null}
    </div>
  );

  return (
    <SketchCard tone="paper" accent="amber" padded={false} className="w-full space-y-2 p-2.5">
      {card.image ? <CardMedia image={card.image} kind={card.kind} /> : null}

      {url ? (
        <button
          type="button"
          title={url}
          aria-label={`Open ${card.title}`}
          className="flex w-full items-center gap-2 rounded-sketch-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashed focus-visible:outline-ink/70"
          onClick={() => openInNewTab(url)}
        >
          {titleRow}
        </button>
      ) : (
        <div className="flex items-center gap-2">{titleRow}</div>
      )}

      {card.subtitle ? (
        <p className="line-clamp-2 font-sketch text-[11px] leading-snug text-ink-500" title={card.subtitle}>
          {card.subtitle}
        </p>
      ) : null}

      {card.badge ? (
        <div className="flex">
          <SketchBadge accent="amber" size="sm">
            {card.badge}
          </SketchBadge>
        </div>
      ) : null}

      {card.details && card.details.length > 0 ? (
        <dl className="space-y-0.5">
          {card.details.map((row, index) => (
            <div key={`${row.label}-${index}`} className="flex items-baseline gap-1.5 text-[11px]">
              <dt className="shrink-0 text-ink-500">{row.label}</dt>
              <dd className="min-w-0 flex-1 truncate text-ink-700" title={row.value}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {actions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {actions.map((action) => {
            const look = buttonLook(action.variant);
            return (
              <SketchButton
                key={action.id}
                size="sm"
                variant={look.variant}
                accent={look.accent}
                className={cn('whitespace-nowrap', action.variant === 'ghost' && 'text-ink-700')}
                onClick={() => handleAction(action)}
              >
                {action.label}
              </SketchButton>
            );
          })}
        </div>
      ) : null}
    </SketchCard>
  );
}
