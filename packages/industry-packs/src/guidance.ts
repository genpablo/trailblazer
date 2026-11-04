/**
 * Pack guidance for the assistant: industry-specific instructions and suggested first questions.
 * Platform-wide rules (grounding, no professional advice, safety) live in the chat engine and
 * cannot be changed by packs or tenants. Fuller pack content arrives in milestone 1.3.
 */

export interface PackGuidance {
  instructions: string;
  quickReplies: Record<"en" | "fr", string[]>;
  variantInstructions?: Record<string, string>;
}

const guidance: Record<string, PackGuidance> = {
  restaurant: {
    instructions: [
      "You help guests of a restaurant or bar with hours, menu, prices, reservations, takeout/delivery, parking, accessibility and events.",
      "Allergens and dietary needs: answer only from the business's menu information, and always add that guests should confirm with staff before ordering.",
      "If reservation or online-ordering links are known, offer them.",
    ].join("\n"),
    variantInstructions: {
      pub: "Alcohol is only served to guests 19 and older (Ontario).",
    },
    quickReplies: {
      en: ["What are your hours?", "Can I see the menu?", "Do you take reservations?"],
      fr: ["Quelles sont vos heures?", "Puis-je voir le menu?", "Prenez-vous les réservations?"],
    },
  },
  "cafe-bakery": {
    instructions: [
      "You help customers of a café or bakery with hours, menu, custom orders (cakes, catering), pre-orders and pickup.",
      "Allergens: answer only from the business's information and add that customers should confirm with staff.",
      "For custom orders, explain how to order (lead time, deposit) when that information is available.",
    ].join("\n"),
    quickReplies: {
      en: ["What are your hours?", "Do you make custom cakes?", "Do you have gluten-free options?"],
      fr: [
        "Quelles sont vos heures?",
        "Faites-vous des gâteaux sur mesure?",
        "Avez-vous des options sans gluten?",
      ],
    },
  },
  retail: {
    instructions: [
      "You help shoppers of a retail store with hours, location, products, services, returns, shipping and gift cards.",
      "Never invent stock levels or prices. If availability isn't in the information, suggest calling or visiting the store.",
    ].join("\n"),
    variantInstructions: {
      florist:
        "For deliveries, mention order cut-off times and delivery areas when the information is available.",
    },
    quickReplies: {
      en: ["What are your hours?", "Where are you located?", "What is your return policy?"],
      fr: ["Quelles sont vos heures?", "Où êtes-vous situés?", "Quelle est votre politique de retour?"],
    },
  },
  "personal-care": {
    instructions: [
      "You help clients of a salon, spa or barber shop with services, prices, booking, cancellation policy and preparation.",
      "Do not give medical or skin-condition advice; suggest a consultation instead.",
    ].join("\n"),
    variantInstructions: {
      "tattoo-piercing":
        "Clients must be 18 or older (or follow the studio's stated policy). Explain consultations, deposits and aftercare only as described by the studio.",
    },
    quickReplies: {
      en: ["How do I book?", "What are your prices?", "What is your cancellation policy?"],
      fr: [
        "Comment prendre rendez-vous?",
        "Quels sont vos prix?",
        "Quelle est votre politique d'annulation?",
      ],
    },
  },
  lodging: {
    instructions: [
      "You help guests of a motel, B&B, lodge or small hotel with rooms, rates, availability, check-in/check-out, amenities, pets, parking and local tips.",
      "Never confirm a reservation or guarantee availability yourself; point to the booking link or phone number.",
    ].join("\n"),
    quickReplies: {
      en: ["What time is check-in?", "Do you allow pets?", "How do I book a room?"],
      fr: ["À quelle heure est l'arrivée?", "Acceptez-vous les animaux?", "Comment réserver une chambre?"],
    },
  },
  attractions: {
    instructions: [
      "You help visitors of an attraction, tour or recreation business with schedules, tickets, prices, conditions, what to bring and directions.",
      "Conditions (weather, snow, trails) change often: only state conditions given in the business's information and suggest checking before coming.",
    ].join("\n"),
    quickReplies: {
      en: ["Are you open today?", "How much are tickets?", "What should I bring?"],
      fr: ["Êtes-vous ouverts aujourd'hui?", "Combien coûtent les billets?", "Que dois-je apporter?"],
    },
  },
  generic: {
    instructions:
      "You help customers of a local business with questions about its services, hours, location, prices and how to get in touch.",
    quickReplies: {
      en: ["What are your hours?", "What services do you offer?", "How can I contact you?"],
      fr: ["Quelles sont vos heures?", "Quels services offrez-vous?", "Comment vous joindre?"],
    },
  },
};

export function getPackGuidance(
  packSlug: string,
  variant?: string | null,
): { instructions: string; quickReplies: PackGuidance["quickReplies"] } {
  const g = guidance[packSlug] ?? guidance.generic!;
  const extra = variant ? g.variantInstructions?.[variant] : undefined;
  return {
    instructions: extra ? `${g.instructions}\n${extra}` : g.instructions,
    quickReplies: g.quickReplies,
  };
}
