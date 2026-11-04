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
    limitQuota: "This assistant can't answer more questions right now. Please contact {business} directly.",
    limitVisitor:
      "You've reached today's question limit for this assistant. Please come back tomorrow, or contact {business} directly.",
    limitConversation: "This conversation is getting long. Please start a new conversation to keep chatting.",
    busy: "Lots of people are asking questions right now. Please try again in a moment.",
    slowDown: "You're sending messages very quickly. Please wait a minute, then try again.",
    phone: "Phone",
    email: "Email",
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
    limitQuota:
      "Cet assistant ne peut pas répondre à d'autres questions pour le moment. Veuillez communiquer directement avec {business}.",
    limitVisitor:
      "Vous avez atteint la limite de questions pour aujourd'hui. Revenez demain ou communiquez directement avec {business}.",
    limitConversation:
      "Cette conversation devient longue. Veuillez commencer une nouvelle conversation pour continuer.",
    busy: "Beaucoup de gens posent des questions en ce moment. Veuillez réessayer dans un instant.",
    slowDown: "Vous envoyez des messages très rapidement. Veuillez attendre une minute, puis réessayer.",
    phone: "Téléphone",
    email: "Courriel",
  },
} as const;

export type StringKey = keyof (typeof strings)["en"];

export function ui(lang: string, key: StringKey, vars: Record<string, string> = {}): string {
  const table = (strings as Record<string, Record<StringKey, string>>)[lang] ?? strings.en;
  return table[key].replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? "");
}
