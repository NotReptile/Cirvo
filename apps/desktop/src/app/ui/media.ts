import { getAppearance } from "../appearance";
import { bindEvent } from "../dom";
import { gifStaticCache, mediaBlobCache } from "../mediaCache";
import { uiContext } from "../state";
import { openImageLightbox } from "./messageView";
import { extractFirstFrame, insertWsRailImg } from "./session";

export function hydrateMedia(fragment: ParentNode): void {
  fragment.querySelectorAll<HTMLDivElement>(".attach-image").forEach((slot) => {
    const url = slot.dataset.mediaUrl;
    if (!url) return;
    // Wave 2: lightbox по клику. Слоты пересоздаются каждым render()
    // (кроме restored через snapshot) — dataset-флаг защищает restored
    // от двойного binding'а.
    if (!slot.dataset.lbBound) {
      slot.dataset.lbBound = "1";
      bindEvent(slot, "click", () => openImageLightbox(slot), "bind-488064");
    }
    // Если restoreImageSlots уже вернул сюда готовый <img> — не пересоздаём,
    // иначе browser декодирует картинку заново и она мигает.
    if (slot.querySelector("img")) return;
    const cached = mediaBlobCache.get(url);
    if (cached) {
      slot.innerHTML = `<img src="${cached}" alt="" />`;
      return;
    }
    void (async () => {
      try {
        const blob = await uiContext.httpClient.getBlob(url);
        const blobUrl = URL.createObjectURL(blob);
        mediaBlobCache.set(url, blobUrl);
        // Между запросом и резолвом мог пройти ре-рендер — повторно
        // выбираем slot по url, иначе пишем в осиротевший элемент.
        const fresh = fragment.querySelector<HTMLDivElement>(
          `.attach-image[data-media-url="${CSS.escape(url)}"]`,
        );
        (fresh ?? slot).innerHTML = `<img src="${blobUrl}" alt="" />`;
      } catch {
        slot.innerHTML = `<div class="attach-image-loader">Не удалось загрузить</div>`;
      }
    })();
  });

  // H.1: lazy-load аватары. Тот же mediaBlobCache что и для attachments,
  // ключ — `/api/v1/media/<id>`. Слот с .avatar-pic.has-media рендерит
  // letter-placeholder под <img> — placeholder остаётся видим, пока blob
  // не приехал; при успешной загрузке мы добавляем <img> сверху (placeholder
  // буква скрыта CSS'ом когда есть .avatar-pic img).
  // I.14: GIF/APNG-аватары. gifStaticCache хранит первый кадр по media-url
  // (присутствие записи = «этот media анимированный»). Режим из I.5:
  // always — анимация всегда; hover — статичный кадр + анимация при
  // наведении; never — только статичный кадр.
  const fillAvatarSlot = (
    s: HTMLSpanElement,
    animUrl: string,
    staticUrl: string | null,
  ): void => {
    if (s.querySelector("img")) return;
    const mode = getAppearance().gifAvatars;
    const useStatic = staticUrl !== null && mode !== "always";
    s.insertAdjacentHTML(
      "afterbegin",
      `<img class="avatar-img" src="${useStatic ? staticUrl : animUrl}" alt="" />`,
    );
    if (staticUrl !== null && mode === "hover" && !s.dataset.gifBound) {
      s.dataset.gifBound = "1";
      bindEvent(
        s,
        "mouseenter",
        () => {
          const img = s.querySelector<HTMLImageElement>(".avatar-img");
          if (img) img.src = animUrl;
        },
        "bind-490198",
      );
      bindEvent(
        s,
        "mouseleave",
        () => {
          const img = s.querySelector<HTMLImageElement>(".avatar-img");
          if (img) img.src = staticUrl;
        },
        "bind-490361",
      );
    }
  };
  fragment
    .querySelectorAll<HTMLSpanElement>(".avatar-pic.has-media")
    .forEach((slot) => {
      const mediaId = slot.dataset.avatarMedia;
      if (!mediaId) return;
      if (slot.querySelector("img")) return;
      const url = `/api/v1/media/${mediaId}`;
      const cached = mediaBlobCache.get(url);
      if (cached) {
        fillAvatarSlot(slot, cached, gifStaticCache.get(url) ?? null);
        return;
      }
      void (async () => {
        try {
          const blob = await uiContext.httpClient.getBlob(url);
          const blobUrl = URL.createObjectURL(blob);
          mediaBlobCache.set(url, blobUrl);
          let staticUrl: string | null = null;
          if (blob.type === "image/gif" || blob.type === "image/apng") {
            staticUrl = await extractFirstFrame(blob, blobUrl);
            if (staticUrl) gifStaticCache.set(url, staticUrl);
          }
          // Может быть несколько слотов с тем же media-id (мой аватар в
          // user-strip и в моих сообщениях). Заполним все.
          fragment
            .querySelectorAll<HTMLSpanElement>(
              `.avatar-pic.has-media[data-avatar-media="${CSS.escape(mediaId)}"]`,
            )
            .forEach((s) => fillAvatarSlot(s, blobUrl, staticUrl));
        } catch {
          // оставляем letter-placeholder
        }
      })();
    });

  // H.2: иконки воркспейсов в ws-rail. Reuse того же mediaBlobCache.
  // ws-rail-icon — это button, не .avatar-pic, поэтому отдельный селектор;
  // <img class="ws-rail-img"> вставляется внутрь, letter-placeholder скрывается
  // CSS-правилом `.ws-rail-icon:has(.ws-rail-img) .ws-rail-letter`.
  fragment
    .querySelectorAll<HTMLButtonElement>(".ws-rail-icon[data-avatar-media]")
    .forEach((slot) => {
      const mediaId = slot.dataset.avatarMedia;
      if (!mediaId) return;
      // GIF hover-swap: один обработчик на slot, переключает src между static и
      // animated. Срабатывает только если у img есть data-anim-src ≠ data-static-src
      // (для не-gif этот атрибут будет одинаковым → swap no-op).
      if (!slot.dataset.hoverBound) {
        slot.dataset.hoverBound = "1";
        bindEvent(
          slot,
          "mouseenter",
          () => {
            const img = slot.querySelector<HTMLImageElement>(".ws-rail-img");
            if (img && img.dataset.animSrc) img.src = img.dataset.animSrc;
          },
          "bind-492537",
        );
        bindEvent(
          slot,
          "mouseleave",
          () => {
            const img = slot.querySelector<HTMLImageElement>(".ws-rail-img");
            if (img && img.dataset.staticSrc) img.src = img.dataset.staticSrc;
          },
          "bind-492742",
        );
      }
      if (slot.querySelector("img")) return;
      const url = `/api/v1/media/${mediaId}`;
      const cached = mediaBlobCache.get(url);
      if (cached) {
        const staticFrame = gifStaticCache.get(url);
        insertWsRailImg(slot, cached, staticFrame);
        return;
      }
      void (async () => {
        try {
          const blob = await uiContext.httpClient.getBlob(url);
          const blobUrl = URL.createObjectURL(blob);
          mediaBlobCache.set(url, blobUrl);
          const staticFrame = await extractFirstFrame(blob, blobUrl);
          if (staticFrame) gifStaticCache.set(url, staticFrame);
          fragment
            .querySelectorAll<HTMLButtonElement>(
              `.ws-rail-icon[data-avatar-media="${CSS.escape(mediaId)}"]`,
            )
            .forEach((s) => {
              if (s.querySelector("img")) return;
              insertWsRailImg(s, blobUrl, staticFrame ?? undefined);
            });
        } catch {
          // letter остаётся видимой
        }
      })();
    });

  // I.6: lazy-load баннер профиля. data-banner-media → blob через тот же
  // mediaBlobCache, вставляется как inline-background через style.
  fragment
    .querySelectorAll<HTMLElement>("[data-banner-media]")
    .forEach((slot) => {
      const mediaId = slot.dataset.bannerMedia;
      if (!mediaId) return;
      if (slot.dataset.bannerLoaded === mediaId) return;
      const url = `/api/v1/media/${mediaId}`;
      const apply = (blobUrl: string) => {
        slot.style.backgroundImage = `url("${blobUrl}")`;
        slot.style.backgroundSize = "cover";
        slot.style.backgroundPosition = "center";
        slot.dataset.bannerLoaded = mediaId;
      };
      const cached = mediaBlobCache.get(url);
      if (cached) {
        apply(cached);
        return;
      }
      void (async () => {
        try {
          const blob = await uiContext.httpClient.getBlob(url);
          const blobUrl = URL.createObjectURL(blob);
          mediaBlobCache.set(url, blobUrl);
          fragment
            .querySelectorAll<HTMLElement>(
              `[data-banner-media="${CSS.escape(mediaId)}"]`,
            )
            .forEach((s) => {
              if (s.dataset.bannerLoaded === mediaId) return;
              apply.call(null, blobUrl);
              s.style.backgroundImage = `url("${blobUrl}")`;
              s.style.backgroundSize = "cover";
              s.style.backgroundPosition = "center";
              s.dataset.bannerLoaded = mediaId;
            });
        } catch {
          /* fallback на bannerColor / default gradient */
        }
      })();
    });
}
