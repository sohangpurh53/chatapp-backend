# AI & Models

Users connect their own AI providers under **Settings > AI & Models** in the app.
Stage 1 stores and tests provider configurations. Stage 2 adds the message assistant in the chat composer.

## Supported providers

| Provider | Address | API key |
| --- | --- | --- |
| OpenAI | fixed: `https://api.openai.com/v1` | required |
| Google Gemini | fixed: `https://generativelanguage.googleapis.com/v1beta` | required |
| Groq | fixed: `https://api.groq.com/openai/v1` | required |
| xAI (Grok) | fixed: `https://api.x.ai/v1` | required |
| Ollama | default `https://ollama.com` (Ollama Cloud), editable | required for ollama.com, optional for a self-hosted server |
| Custom (OpenAI-compatible) | user-supplied | optional |

## Server setup

1. Generate an encryption key for stored API keys:

   ```
   npm run generate-ai-key
   ```

2. Add it to the server `.env`:

   ```
   AI_CREDENTIALS_KEY=<64 hex characters>
   ```

   Without it, the app can only add providers that need no key, and it shows a warning.

3. Restart the server. `sequelize.sync({ alter: true })` creates the `AiProviderConfigs` and `AiUserSettings` tables.

Optional variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_CREDENTIALS_KEY_PREVIOUS` | empty | Old keys during rotation (comma-separated). Used only to decrypt; keys are re-encrypted with the current key on next use. |
| `AI_ALLOW_PRIVATE_ENDPOINTS` | `false` | Allow Ollama/custom endpoints on loopback or private networks. Leave off on a shared server. |
| `AI_REQUEST_TIMEOUT_MS` | `30000` | Timeout for provider requests. |
| `AI_MAX_PROVIDERS_PER_USER` | `20` | Limit on saved providers per user. |

## API (all routes need a signed-in user)

| Method and path | Purpose |
| --- | --- |
| `GET /api/ai/config` | Settings, the user's providers, catalogue, features, server capabilities |
| `PUT /api/ai/settings` | Partial update: `enabled`, `defaultProviderId`, `defaultModel`, `features`, `limits` |
| `POST /api/ai/providers` | Add a provider |
| `PUT /api/ai/providers/:id` | Edit. Omit `apiKey` to keep the saved key; `clearApiKey: true` removes it |
| `DELETE /api/ai/providers/:id` | Remove; settings that pointed at it are cleared |
| `POST /api/ai/providers/:id/test` | List models, then send one short sample prompt to the chosen model |
| `GET /api/ai/providers/:id/models?refresh=true` | Fetch the provider's model list |
| `POST /api/ai/memory` | Group memory: answers from evidence the phone selected (`chatId`, `question` or `mode: summary`, `evidence[]`). Cites refs; invented refs are dropped |
| `POST /api/ai/actions` | Action cards: proposed tasks, events, polls, decisions, follow-ups from evidence. Owners need cited messages; deadlines need their exact wording in a cited message |
| `POST /api/ai/assist` | Message assistant: returns editable drafts, never sends. Actions: `compose`, `rewrite` (+`tone`), `fix_grammar`, `shorter`, `longer`, `alternatives`, `translate` (+`language`), `reply` (+`chatId`, `context`) |

Rate limits per user: 120 requests a minute overall, 30 writes a minute, 12 connection tests or model fetches a minute, 30 assistant requests a minute. The counters are in memory, so each server instance counts separately.

## Security design

- **Keys are write-only.** The API returns `hasApiKey` and a hint such as `••••abcd`, never the key or its ciphertext. The default model scope excludes the ciphertext column.
- **Encryption at rest.** AES-256-GCM, with the user id and provider id as additional data, so a ciphertext copied to another row will not decrypt.
- **SSRF protection.** Base URLs must be http(s) with no credentials, query or fragment. Every resolved address is checked when connecting, which also blocks DNS rebinding. Link-local and metadata addresses are always blocked. Private networks are blocked unless `AI_ALLOW_PRIVATE_ENDPOINTS=true`. Plain HTTP only goes to private addresses. Redirects are never followed. Responses are capped at 5 MB.
- **No silent fallback.** A feature uses its own provider, or else the default. If that provider is missing, disabled or failing, the feature returns an error. It never switches to another service.
- **Redaction.** Provider error text is stripped of key-shaped strings and the exact key before it is logged or returned.

## Message assistant (stage 2)

- `rewrite`, `fix_grammar`, `shorter`, `longer`, `alternatives` and `compose` run on the **assistant** feature, `translate` on **translation**, and `reply` on **replies**. Each uses the provider and model chosen for that feature.
- Only `reply` sends conversation context. The app sends at most 15 recent text messages it has already decrypted, with speakers renamed "Me", "Person 1", "Person 2". The server accepts context only for chats where the caller is an active member.
- Prompts tell the model not to add facts, dates, commitments or promises, and to treat the draft and conversation as data, not instructions.
- Usage limits are enforced before a request reaches the provider. `AiUsageEvents` stores counts, tokens, model and status only, never text.
- Closing the app's request (Cancel) aborts the provider call.

## Group memory and action cards (stages 3 and 4)

- Messages are end-to-end encrypted, so the phone loads the chat history the user can see, decrypts it, and selects evidence: keyword matches with surrounding context for a question (up to 60 messages), the latest messages for summaries (up to 120) and action cards (up to 100). Senders are sent as "Me" / "Person N"; the phone puts real names back into answers. File messages are described by their file name only.
- The server accepts evidence only from active chat members and never stores it.
- Action cards are proposals. Tasks and reminders are saved on the phone (AsyncStorage, local notifications); events open a pre-filled Google Calendar entry; polls, decision summaries and assignments are put in the message box for the user to send, so they stay end-to-end encrypted.

## Privacy note for later stages

AI requests go through this server: the app decrypts the text it needs on the phone and sends it to the server, which forwards it to the provider. The server and a cloud provider can read that text, so this step is not end-to-end encrypted. The app's AI settings screen says so. Consent flows come in stage 6.

## Tests

```
npm test        # backend, Node's built-in runner
```

App tests are in `ChatApp/src/screens/__tests__/AiSettingsScreens.test.tsx`.
