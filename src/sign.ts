// Printable booth notice (/sign): the host's information duty towards their
// guests (GDPR Art. 13; the host is the controller of the photos, we process
// them for the host). Linked from event.html, the event email and settings.
//
//   ?event=<name>  event name (editable on the page)
//   ?days=<n>      retention shown (default: paid 365, free 30)
//   ?mode=free     booth without an online gallery (QR sharing only)
//   ?lang=en|nl|fr default: the browser's language

import { $ } from './dom.ts';

type Lang = 'en' | 'nl' | 'fr';
type Mode = 'gallery' | 'free';

interface Texts {
  kicker: string;
  title: Record<Mode, string>;
  points: Record<Mode, (days: number) => string[]>;
  host: string;
  hostBlank: string;
  footer: string;
}

const EMAIL = 'hello@small-victories.co';
const PRIVACY = 'boot.small-victories.co/privacy';

const TEXTS: Record<Lang, Texts> = {
  en: {
    kicker: 'Photo booth',
    title: {
      gallery: 'Your photos go to an online gallery',
      free: 'Your photos stay here unless you take them',
    },
    points: {
      gallery: (days) => [
        "Every photo you keep at this booth is uploaded to the event's private online gallery. The host shares its link with the guests. Press Retake and that photo isn't uploaded.",
        `Photos are deleted automatically ${days} days after they're taken.`,
        `Rather not be in it? Don't use the booth, press Retake, or delete your photo yourself: scan its QR code and tap “Delete from the server”. Already in the gallery? Ask the host, or mail ${EMAIL}.`,
      ],
      free: (days) => [
        'Tap “Get photo” to get your photo on your phone through a QR code. It is then kept online for ' +
          `${days} days; anyone with its link can see it, and you can delete it from its page.`,
        'The host may keep a copy of the photos on this device.',
        `Want a photo removed? Ask the host, or mail ${EMAIL}.`,
      ],
    },
    host: 'Organised by:',
    hostBlank: '……………………………',
    footer: `The host is responsible for these photos. Photoboot by Small Victories stores them for the host. Privacy: ${PRIVACY}`,
  },
  nl: {
    kicker: 'Fotobooth',
    title: {
      gallery: "Je foto's gaan naar een online galerij",
      free: "Je foto's blijven hier, tenzij je ze meeneemt",
    },
    points: {
      gallery: (days) => [
        'Elke foto die je in deze booth bewaart, gaat naar de besloten online galerij van het feest. De organisator deelt de link met de gasten. Druk je op Opnieuw, dan wordt die foto niet geüpload.',
        `Foto's worden automatisch gewist ${days} dagen nadat ze genomen zijn.`,
        `Liever niet? Gebruik de booth niet, druk op Opnieuw, of wis je foto zelf: scan de QR-code en tik op “Delete from the server”. Staat hij al in de galerij? Vraag het de organisator, of mail ${EMAIL}.`,
      ],
      free: (days) => [
        'Tik op “Foto ophalen” om je foto via een QR-code op je gsm te krijgen. Hij blijft dan ' +
          `${days} dagen online; wie de link heeft, kan hem zien, en je kunt hem wissen op zijn pagina.`,
        "De organisator kan een kopie van de foto's op dit toestel bewaren.",
        `Wil je een foto laten wissen? Vraag het de organisator, of mail ${EMAIL}.`,
      ],
    },
    host: 'Georganiseerd door:',
    hostBlank: '……………………………',
    footer: `De organisator is verantwoordelijk voor deze foto's. Photoboot van Small Victories bewaart ze voor de organisator. Privacy: ${PRIVACY}`,
  },
  fr: {
    kicker: 'Photomaton',
    title: {
      gallery: 'Vos photos vont dans une galerie en ligne',
      free: 'Vos photos restent ici, sauf si vous les prenez',
    },
    points: {
      gallery: (days) => [
        "Chaque photo que vous gardez dans ce photomaton est envoyée dans la galerie en ligne privée de l'événement. L'organisateur en partage le lien avec les invités. Si vous appuyez sur Reprendre, la photo n'est pas envoyée.",
        `Les photos sont supprimées automatiquement ${days} jours après la prise de vue.`,
        `Vous préférez ne pas y figurer ? N'utilisez pas le photomaton, appuyez sur Reprendre, ou supprimez vous-même votre photo : scannez son code QR et touchez « Delete from the server ». Déjà dans la galerie ? Demandez à l'organisateur, ou écrivez à ${EMAIL}.`,
      ],
      free: (days) => [
        'Touchez « Récupérer la photo » pour recevoir votre photo sur votre téléphone via un code QR. Elle reste alors en ligne ' +
          `${days} jours ; toute personne qui a le lien peut la voir, et vous pouvez la supprimer depuis sa page.`,
        "L'organisateur peut garder une copie des photos sur cet appareil.",
        `Vous voulez faire supprimer une photo ? Demandez à l'organisateur, ou écrivez à ${EMAIL}.`,
      ],
    },
    host: 'Organisé par :',
    hostBlank: '……………………………',
    footer: `L'organisateur est responsable de ces photos. Photoboot de Small Victories les conserve pour lui. Vie privée : ${PRIVACY}`,
  },
};

const params = new URLSearchParams(location.search);
const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

const browserLang = navigator.language.slice(0, 2);
const langSelect = $<HTMLSelectElement>('lang');
const modeSelect = $<HTMLSelectElement>('mode');
langSelect.value = pick(params.get('lang') ?? browserLang, ['en', 'nl', 'fr'] as const, 'en');
modeSelect.value = pick(params.get('mode'), ['gallery', 'free'] as const, 'gallery');
$('event').textContent = params.get('event') ?? '';

function render() {
  const lang = langSelect.value as Lang;
  const mode = modeSelect.value as Mode;
  const t = TEXTS[lang];
  const days = Number(params.get('days')) || (mode === 'gallery' ? 365 : 30);
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll<HTMLElement>('[data-t]')) {
    const key = el.dataset.t as 'kicker' | 'title' | 'host' | 'footer';
    el.textContent = key === 'title' ? t.title[mode] : t[key];
  }
  const list = $('points');
  list.replaceChildren(
    ...t.points[mode](days).map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    })
  );
  const host = $('host');
  if (!host.dataset.edited) host.textContent = t.hostBlank;
  $('event').hidden = mode === 'free' && !$('event').textContent;
}

$('host').addEventListener('input', () => {
  $('host').dataset.edited = '1';
});
langSelect.addEventListener('change', render);
modeSelect.addEventListener('change', render);
$('print').addEventListener('click', () => print());
render();
