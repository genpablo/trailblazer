/** Chat UI strings. English and French now; Tier 2 languages get reviewed strings in Phase 2. */
const strings = {
  en: {
    placeholder: "Type your message…",
    send: "Send",
    close: "Close chat",
    sources: "Sources",
    language: "Language",
    thinking: "Typing…",
    error: "Sorry, something went wrong. Please try again.",
    unavailable: "This assistant isn't available right now.",
    poweredBy: "Powered by Traiblazer",
    greeting: "Hi! I'm the assistant for {business}. How can I help you today?",
    greetingNamed: "Hi! I'm {name}, the assistant for {business}. How can I help you today?",
    disclaimer: "Answers are generated automatically and may contain mistakes.",
    newChat: "New conversation",
  },
  fr: {
    placeholder: "Écrivez votre message…",
    send: "Envoyer",
    close: "Fermer la conversation",
    sources: "Sources",
    language: "Langue",
    thinking: "En train d'écrire…",
    error: "Désolé, une erreur s'est produite. Veuillez réessayer.",
    unavailable: "Cet assistant n'est pas disponible pour le moment.",
    poweredBy: "Propulsé par Traiblazer",
    greeting: "Bonjour! Je suis l'assistant de {business}. Comment puis-je vous aider?",
    greetingNamed: "Bonjour! Je suis {name}, l'assistant de {business}. Comment puis-je vous aider?",
    disclaimer: "Les réponses sont générées automatiquement et peuvent contenir des erreurs.",
    newChat: "Nouvelle conversation",
  },
} as const;

export type StringKey = keyof (typeof strings)["en"];

export function ui(lang: string, key: StringKey, vars: Record<string, string> = {}): string {
  const table = (strings as Record<string, Record<StringKey, string>>)[lang] ?? strings.en;
  return table[key].replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? "");
}
