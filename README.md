# MCP Codebase Server

MCP сервер для семантической навигации по кодовой базе. Строит AST-индекс символов, импортов и экспортов, предоставляя высокоуровневые инструменты для ИИ-агента.

## Возможности

- **Поиск символов** — ищет функции, классы, интерфейсы, методы и др. по имени с поддержкой wildcard (`*`, `?`) и OR (`|`)
- **Детали символа** — показывает исходный код, сигнатуру, документацию, импорты файла
- **Обзор модуля** — структура директории, ключевые символы, поддиректории, топ импортов
- **Поиск использований** — находит все ссылки на символ в проекте
- **Зависимости модуля** — импорты, экспорты, файлы, которые используют данный модуль
- **Переиндексация** — полная или инкрементальная (по mtime)
- **Watch mode** — автоматическое обновление индекса при изменении файлов

## Поддерживаемые языки

| Язык | Парсер | Символы | Импорты | Экспорты |
|------|--------|---------|---------|----------|
| TypeScript / JavaScript | TypeScript Compiler API | ✅ | ✅ | ✅ |
| C# | Regex-based (lightweight) | ✅ | ✅ (using) | ✅ (public) |

Архитектура позволяет легко добавлять новые языки через интерфейс `ILanguageParser`.

## Требования

- Node.js 18+
- PostgreSQL 14+

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
├── tools/
│   ├── search-symbols.ts
│   ├── symbol-details.ts
│   ├── explore-module.ts
│   ├── find-usages.ts
│   ├── module-deps.ts
│   └── reindex.ts
└── utils/
    ├── gitignore.ts
    └── paths.ts
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
