# Tasks

Этот документ разбивает comment-first MVP из `README.md` на самостоятельные сессии разработки. Задачи выполняются по порядку и каждая должна завершаться рабочим состоянием репозитория.

## Чеклист задач

- [x] 01. Cloudflare Worker scaffold
- [x] 02. Env validation and typed config
- [x] 03. D1 migrations and minimal data access
- [x] 04. Instagram webhook verification and signed intake
- [x] 05. Queue consumer and idempotent processing shell
- [x] 06. Webhook comment normalization
- [x] 07. Typed Meta Graph API client
- [x] 08. Comment keyword matching and private replies
- [x] 09. Authenticated media comments backfill
- [x] 10. Retry policy, rate-limit guard and operational errors
- [x] 11. Token lifecycle and Cron maintenance
- [x] 12. Bun admin commands
- [x] 13. Local Wrangler/D1 smoke with real local bindings
- [ ] 14. Deploy and Meta App Review documentation pass
- [ ] 15. End-to-end MVP acceptance run with real Meta app/account

## Общие правила для каждой сессии

- Перед изменениями перечитать `README.md`, этот файл и код в затрагиваемом слое.
- Для нетривиального поведения идти через короткий TDD-цикл: сначала тест/fixture на ожидаемое поведение, потом минимальная реализация, затем рефакторинг.
- Не добавлять `instagram-private-api`, браузерную автоматизацию, cookie/session automation, GitHub Actions или холодную рассылку старым комментаторам.
- Сохранять ручной deploy workflow через Bun/Wrangler.
- После каждой задачи запускать минимальную проверку измененного слоя и `bun run typecheck`.
- Если меняются setup, контракты, схемы данных, маршруты, env или операционные ограничения, обновлять `README.md` или отдельные docs в той же сессии.

## 01. Cloudflare Worker scaffold

**Цель:** заменить Bun-заглушку на Cloudflare Worker с Hono, Wrangler и локальным dev-циклом.

**Сделано:**

- `wrangler.toml`, Hono app и Worker entrypoint.
- `GET /health`.
- Scripts: `dev`, `deploy`, `typecheck`, `test`, `cf-typegen`.

**Primary signal status:** Worker имеет Cloudflare entrypoint и health endpoint.

**Secondary signal status:** `bun run typecheck` проходит.

## 02. Env validation and typed config

**Цель:** единый источник правды для runtime-конфига и feature flags.

**Сделано:**

- `zod`-валидация env.
- `BOT_ENABLED`, `DM_AUTOREPLY_ENABLED=false`, общий `config/reply-rules.json`, retry/rate-limit flags.
- Безопасный public config для `bot:status`.
- Tests для valid/invalid env.

## 03. D1 migrations and minimal data access

**Цель:** первичная SQL-схема для raw events, comments, jobs, attempts, backfill и account status.

**Сделано:**

- `migrations/0001_initial.sql`.
- Minimal D1 repository без ORM.
- Unique keys для webhook event key, reply job idempotency key и unique commenter per media.

## 04. Instagram webhook verification and signed intake

**Цель:** безопасный входной слой webhook без отправки ответов в HTTP request path.

**Сделано:**

- `GET /webhooks/instagram`.
- `POST /webhooks/instagram` читает raw body, проверяет `X-Hub-Signature-256`, сохраняет raw event и публикует queue message.
- Duplicate delivery возвращает `ok` без повторной постановки.

## 05-08. Comment processing flow

**Цель:** realtime comment-to-DM сценарий MVP.

**Сделано:**

- Нормализация comment webhook payloads.
- `live_comments` сохраняются как `live`, но не создают private-reply jobs в MVP.
- Игнорирование unsupported shapes как не создающих replies.
- Keyword matching v1: normalized case-insensitive substring.
- Проверка self-comment, 7-дневного окна и idempotency по `comment_id`.
- Private reply через `graph.instagram.com/{version}/{ig_user_id}/messages` с `recipient.comment_id`.
- Опциональный public reply через `/{comment_id}/replies` и проверка существующего conversation перед созданием/отправкой jobs.
- Persist outbound result, attempts и Meta error details.

## 09. Authenticated media comments backfill

**Цель:** ручной безопасный backfill старых media comments без нарушения ограничений Meta.

**Сделано:**

- `POST /admin/backfill/media/:mediaId`.
- `bun run backfill:comments -- --media <mediaId>`.
- `bun run backfill:comments -- --media <mediaId> --send`.
- Resume больших media через `--after <cursor>` и лимит `BACKFILL_MAX_PAGES_PER_RUN`.
- Pagination через `/comments`.
- Сохранение comments и unique commenters.
- Reply jobs только для keyword comments в 7-дневном окне и только при `BACKFILL_REPLY_ENABLED=true`.
- Backfill с `--send` создаёт eligible reply jobs; отправку выполняет scheduled sender.
- Старые comments только сохраняются.

## 10-11. Retry, rate-limit and token lifecycle

**Цель:** контролируемая отправка и минимальное операционное обслуживание.

**Сделано:**

- Retryable/non-retryable decisions по Meta HTTP/code.
- `MAX_REPLY_ATTEMPTS`, `next_retry_at`, attempt history.
- Атомарный D1-slot guard `RATE_LIMIT_MESSAGES_PER_MINUTE`.
- Повторная проверка 7-дневного окна непосредственно перед отправкой retry job.
- `BOT_ENABLED=false` ставит jobs на retry pause; disabled reply flags блокируют jobs выключенного типа, чтобы такой backlog не занимал scheduled sender.
- Cron token health check раз в 10 минут переводит account в `active` / `token_invalid`.
- Ежеминутный Cron обрабатывает due reply jobs в пределах `RATE_LIMIT_MESSAGES_PER_MINUTE`.

## 12. Bun admin commands

**Цель:** простой ручной интерфейс без React-админки.

**Сделано:**

- `bun run bot:status`.
- `bun run backfill:comments -- --media <mediaId>`.
- `bun run backfill:account-comments -- --send --max-media-pages <n>`.
- `ADMIN_BASE_URL` / `PUBLIC_BASE_URL` для выбора Worker URL.

## 13. Local Wrangler/D1 smoke

**Цель:** подтвердить, что bindings работают в локальном Wrangler окружении.

**Сделать:**

- Применить local D1 migration.
- Запустить `bun run smoke:d1`.
- Проверить реальные local D1 migrations, ключевые таблицы/колонки и базовый insert/select path для comments/reply jobs.

**Primary signal status:** local D1 schema smoke проходит через Wrangler local database.

## 14. Deploy and Meta App Review documentation pass

**Цель:** подготовить инструкции для ручного production запуска и прохождения Meta App Review.

**Сделать:**

- Сверить README команды с фактическими Cloudflare resource IDs.
- Описать Meta setup для Creator account.
- Подготовить App Review checklist: comment keyword, private reply, backfill без холодной рассылки.
- Добавить troubleshooting для signature mismatch, invalid token, missing scopes, rate limits и duplicate events.

## 15. End-to-end MVP acceptance run

**Цель:** подтвердить MVP на реальном или максимально близком к реальному окружении.

**Сделать:**

- Применить D1 migrations в целевом окружении.
- Задеплоить Worker вручную через Wrangler.
- Проверить webhook verification endpoint в Meta.
- Проверить новый комментарий с ключевым словом, conversation guard и включённые public/private replies.
- Проверить новый комментарий без ключевого слова.
- Проверить duplicate delivery.
- Запустить backfill на тестовом `media_id` и подтвердить immediate replies только для comments младше 7 дней без существующего conversation.

**Primary signal status:** все primary acceptance criteria из README подтверждены или явно перечислены как не пройденные с причиной.
