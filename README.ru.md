# MCP Codebase Server

[English version](README.md)

MCP сервер для семантической навигации по кодовой базе. Строит AST-индекс символов, импортов и экспортов, предоставляя высокоуровневые инструменты для ИИ-агента.

## Возможности

- **Обзор проекта** — дешёвая «карта репозитория» из индекса: счётчики, топ-директории, ключевые экспортируемые символы, ранжированные по числу импортёров
- **Поиск символов** — ищет функции, классы, интерфейсы, методы и др. по имени с поддержкой wildcard (`*`, `?`) и OR (`|`)
- **Детали символа** — показывает исходный код, сигнатуру, документацию, импорты файла
- **Обзор модуля** — структура директории, ключевые символы, поддиректории, топ импортов
- **Поиск использований** — находит все ссылки на символ в проекте (текстовый поиск)
- **Семантическая навигация** (через LSP): `find_references` (точный «кто вызывает») и `go_to_definition` (переход к определению + hover-информация)
- **Зависимости модуля** — импорты, экспорты, файлы, которые используют данный модуль
- **Переиндексация** — полная или инкрементальная (по mtime)
- **Watch mode** — автоматическое обновление индекса при изменении файлов
- **Семантический рефакторинг** (через language servers, LSP): `rename_symbol`,
  `get_diagnostics`, `move_file`, `organize_imports`, `fix_all`, `extract_method` — все
  с поддержкой `dryRun` и автоматической переиндексацией изменённых файлов
- **Телеметрия инструментов** — `get_tool_stats` показывает счётчики вызовов/ошибок
  по каждому инструменту за время жизни процесса

Всего 16 MCP-инструментов: 7 навигационных, 8 LSP-backed, 1 телеметрия. Измеренная
экономия контекста против grep-only цикла агента — в `docs/benchmark.md` (~18x меньше
байт на этом репозитории).

## Поддерживаемые языки

| Язык | Парсер | Символы | Импорты | Экспорты |
|------|--------|---------|---------|----------|
| TypeScript / JavaScript | TypeScript Compiler API | ✅ | ✅ | ✅ |
| C# | Regex-based (lightweight) | ✅ | ✅ (using) | ✅ (public) |

Архитектура позволяет легко добавлять новые языки через интерфейс `ILanguageParser`.

## Требования

- Node.js 18+
- PostgreSQL 14+
- Для инструментов рефакторинга C#: .NET SDK + dotnet tool `csharp-ls` (для TS/JS работает из коробки через bundled `typescript-language-server`)

## Установка

```bash
npm install
npm run build
```

## Настройка

Переменные окружения:

| Переменная | Описание | По умолчанию |
|------------|----------|--------------|
| `PROJECT_ROOT` | Корневая директория проекта | `process.cwd()` |
| `PGHOST` | Хост PostgreSQL | `localhost` |
| `PGPORT` | Порт PostgreSQL | `5432` |
| `PGDATABASE` | Имя базы данных | `codebase_index` |
| `PGUSER` | Пользователь PostgreSQL | `postgres` |
| `PGPASSWORD` | Пароль PostgreSQL | `postgres` |

## Интеграция с Kimi CLI

Добавьте в `kimi-mcp.json`:

```json
{
  "mcpServers": {
    "codebase": {
      "command": "node",
      "args": ["<path-to-mcp-codebase>/dist/index.js"],
      "env": {
        "PROJECT_ROOT": "<path-to-your-codebase>",
        "PGHOST": "localhost",
        "PGPORT": "5432",
        "PGDATABASE": "codebase_index",
        "PGUSER": "postgres",
        "PGPASSWORD": "your_password"
      }
    }
  }
}
```

## Инструменты MCP

### `project_overview`
Дешёвая карта проекта — вызывайте первым на незнакомом проекте.

```json
{ "max_symbols": 20 }
```

### `search_symbols`
Поиск символов по имени с фильтрацией.

```json
{
  "query": "UserService|useAuth|*Controller",
  "kind": "class|function",
  "language": "typescript",
  "file_path": "src/services",
  "limit": 20
}
```

### `get_symbol_details`
Полная информация о символе.

```json
{ "symbol_id": 123 }
// или
{ "name": "UserService", "file_path": "src/services/UserService.ts" }
```

### `explore_module`
Обзор директории.

```json
{ "path": "src/services", "depth": 1 }
```

### `find_usages`
Поиск использований символа.

```json
{ "name": "UserService", "file_path": "src/services/UserService.ts" }
```

### `get_module_dependencies`
Граф зависимостей файла.

```json
{ "path": "src/services/UserService.ts" }
```

### `reindex`
Принудительная переиндексация.

```json
{ "full": false }
```

### Инструменты рефакторинга (через LSP)

Требуют language server для типа файла (TS/JS из коробки; для C# нужен `csharp-ls`).
Все инструменты записи принимают `dryRun: true` для предпросмотра правок без записи.

- `find_references` — `{ "file_path": "src/util.ts", "line": 12, "column": 17 }` (семантические ссылки)
- `go_to_definition` — `{ "file_path": "src/main.ts", "line": 5, "column": 10 }` (определение + hover)
- `rename_symbol` — `{ "file_path": "src/util.ts", "line": 12, "column": 17, "new_name": "hello" }`
- `get_diagnostics` — `{ "file_path": "src/util.ts", "severity": "error" }` (без `file_path` — все сохранённые диагностики)
- `move_file` — `{ "old_path": "src/a.ts", "new_path": "src/lib/a.ts" }`
- `organize_imports` — `{ "file_path": "src/a.ts" }`
- `fix_all` — `{ "file_path": "src/a.ts" }`
- `extract_method` — `{ "file_path": "src/a.ts", "start_line": 10, "end_line": 20, "new_name": "helper" }`
- `get_tool_stats` — `{}` (счётчики вызовов/ошибок по инструментам)

Переменные окружения LSP: `LSP_ENABLED`, `TSSERVER_CMD`, `CSHARPLS_CMD`,
`LSP_STARTUP_TIMEOUT_MS`, `LSP_REQUEST_TIMEOUT_MS`, `MCP_ERROR_LOG` — см. `docs/configuration.md`.

## Архитектура

```
src/
├── index.ts                 # MCP server
├── config.ts                # Конфигурация
├── db/
│   ├── connection.ts        # Пул PostgreSQL
│   ├── schema.ts            # DDL и миграции
│   └── repositories.ts      # Запросы к БД
├── indexer/
│   ├── file-crawler.ts      # Обход файлов
│   ├── indexer.ts           # Оркестрация индексации
│   └── watcher.ts           # Watch mode (chokidar)
├── parsers/
│   ├── interface.ts         # ILanguageParser
│   ├── typescript.ts        # TS/JS парсер
│   └── csharp.ts            # C# парсер
├── lsp/
│   ├── client.ts            # LSP-клиент по stdio
│   ├── backend.ts           # Контракт ILspBackend
│   ├── tsserver-backend.ts  # typescript-language-server
│   ├── csharp-backend.ts    # csharp-ls (нужен .NET SDK)
│   ├── registry.ts          # Жизненный цикл бэкендов
│   ├── edits.ts             # Применение WorkspaceEdit
│   └── positions.ts         # path↔URI, позиции
├── tools/
│   ├── search-symbols.ts
│   ├── symbol-details.ts
│   ├── explore-module.ts
│   ├── find-usages.ts
│   ├── module-deps.ts
│   ├── reindex.ts
│   ├── project-overview.ts
│   ├── tool-stats.ts
│   └── refactor/            # find-references, go-to-definition, rename-symbol,
│                            # get-diagnostics, move-file, organize-imports,
│                            # fix-all, extract-method
└── utils/
    ├── gitignore.ts
    ├── paths.ts
    └── stats.ts             # телеметрия инструментов
benchmarks/                  # микро-бенчмарк (см. docs/benchmark.md)
```

## Производительность

На проекте `lowcodeplatform` (~71K файлов, ~730 исходных файлов без node_modules/dist):
- Полная индексация: ~1.3 сек
- Символов в индексе: ~5000
- Поиск символа: < 50 мс

## Расширение на другие языки

1. Создайте класс, реализующий `ILanguageParser`
2. Зарегистрируйте его в `src/indexer/indexer.ts`
3. Добавьте расширение в `config.languageMap`

Пример:
```typescript
export class PythonParser implements ILanguageParser {
  readonly supportedExtensions = ['.py'];
  readonly languageId = 'python';
  parse(filePath: string, content: string): ParseResult | null { ... }
}
```
