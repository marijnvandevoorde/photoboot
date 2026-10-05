// Guest-facing wording. The admin picks a language in settings and can
// override any single string (config.texts[key]); empty overrides fall back
// to the language, then to English. `{n}`-style placeholders are filled in
// by t(key, { n: … }).

export const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'nl', label: 'Nederlands' },
  { id: 'fr', label: 'Français' },
];

export const STRINGS = {
  en: {
    takePhoto: 'Take photo',
    timer: 'Timer',
    photos: 'Photos',
    tapToStart: 'Tap to take your photo!',
    getReady: 'Get ready…',
    smile: 'Smile!',
    nextPose: 'Next pose!',
    photoOf: 'Photo {n} of {total}',
    cancel: 'Cancel',
    retake: 'Retake',
    print: 'Print',
    printAgain: 'Print again',
    share: 'Get photo',
    done: 'Done',
    printing: 'Printing…',
    grabSticker: 'Grab your sticker below ↓',
    printed: 'Printed!',
    printLimit: 'No more prints for this photo',
    printerOffline: 'The printer is resting. Ask the host — you can still get your photo by QR.',
    printFailed: "Printing didn't work. Please ask the host.",
    preparing: 'Preparing your photo…',
    scanQr: 'Point your phone camera here',
    colourVersion: "You'll get the colour version",
    shareFailed: "Couldn't prepare your photo. Try again in a moment.",
    cameraError: "The camera isn't working right now.",
    cameraHint: 'Please ask the host to check the camera.',
    tryAgain: 'Try again',
  },
  nl: {
    takePhoto: 'Neem foto',
    timer: 'Timer',
    photos: "Foto's",
    tapToStart: 'Tik om je foto te nemen!',
    getReady: 'Maak je klaar…',
    smile: 'Lachen!',
    nextPose: 'Volgende pose!',
    photoOf: 'Foto {n} van {total}',
    cancel: 'Annuleer',
    retake: 'Opnieuw',
    print: 'Print',
    printAgain: 'Nog eens printen',
    share: 'Foto ophalen',
    done: 'Klaar',
    printing: 'Bezig met printen…',
    grabSticker: 'Pak je sticker hieronder ↓',
    printed: 'Geprint!',
    printLimit: 'Geen prints meer voor deze foto',
    printerOffline: 'De printer rust even. Vraag het aan de gastheer — je foto ophalen via QR kan nog wel.',
    printFailed: 'Printen is mislukt. Vraag het even aan de gastheer.',
    preparing: 'Je foto wordt klaargemaakt…',
    scanQr: 'Richt je gsm-camera hierop',
    colourVersion: 'Je krijgt de versie in kleur',
    shareFailed: 'Je foto klaarmaken lukte niet. Probeer zo meteen opnieuw.',
    cameraError: 'De camera werkt nu even niet.',
    cameraHint: 'Vraag de gastheer om de camera na te kijken.',
    tryAgain: 'Opnieuw proberen',
  },
  fr: {
    takePhoto: 'Prendre la photo',
    timer: 'Minuteur',
    photos: 'Photos',
    tapToStart: 'Touchez pour prendre votre photo !',
    getReady: 'Préparez-vous…',
    smile: 'Souriez !',
    nextPose: 'Pose suivante !',
    photoOf: 'Photo {n} sur {total}',
    cancel: 'Annuler',
    retake: 'Reprendre',
    print: 'Imprimer',
    printAgain: 'Imprimer encore',
    share: 'Récupérer la photo',
    done: 'Terminé',
    printing: 'Impression…',
    grabSticker: 'Prenez votre autocollant en bas ↓',
    printed: 'Imprimé !',
    printLimit: "Plus d'impressions pour cette photo",
    printerOffline: "L'imprimante se repose. Demandez à l'hôte — la photo reste disponible par QR.",
    printFailed: "L'impression a échoué. Demandez à l'hôte.",
    preparing: 'Préparation de votre photo…',
    scanQr: 'Visez ce code avec l’appareil photo de votre téléphone',
    colourVersion: 'Vous recevrez la version en couleur',
    shareFailed: 'Impossible de préparer la photo. Réessayez dans un instant.',
    cameraError: 'La caméra ne fonctionne pas pour le moment.',
    cameraHint: "Demandez à l'hôte de vérifier la caméra.",
    tryAgain: 'Réessayer',
  },
};

// Keys shown in the settings "Wording" editor, in a sensible order.
export const STRING_KEYS = Object.keys(STRINGS.en);

export function translator(config) {
  const lang = STRINGS[config.language] ?? STRINGS.en;
  const overrides = config.texts ?? {};
  return (key, vars = {}) => {
    const text = overrides[key]?.trim() || lang[key] || STRINGS.en[key] || key;
    return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
  };
}
