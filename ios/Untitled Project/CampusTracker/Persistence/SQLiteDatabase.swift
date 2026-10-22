import Foundation
import SQLite3

nonisolated enum SQLiteError: Error, Equatable, CustomStringConvertible {
    case open(String)
    case prepare(String, sql: String)
    case bind(String)
    case step(String, code: Int32)
    case exec(String, sql: String)

    var description: String {
        switch self {
        case let .open(message): return "SQLITE_OPEN_FAILED: \(message)"
        case let .prepare(message, sql): return "SQLITE_PREPARE_FAILED: \(message) sql=\(sql)"
        case let .bind(message): return "SQLITE_BIND_FAILED: \(message)"
        case let .step(message, code): return "SQLITE_STEP_FAILED(\(code)): \(message)"
        case let .exec(message, sql): return "SQLITE_EXEC_FAILED: \(message) sql=\(sql)"
        }
    }
}

nonisolated enum SQLiteValue: Sendable, Equatable {
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob(Data)
    case null

    static func int(_ value: Int) -> SQLiteValue { .integer(Int64(value)) }
    static func optionalText(_ value: String?) -> SQLiteValue { value.map(SQLiteValue.text) ?? .null }
    static func optionalBlob(_ value: Data?) -> SQLiteValue { value.map(SQLiteValue.blob) ?? .null }
}

/// SQLITE_TRANSIENT: tells SQLite to copy bound text/blob bytes before `bind` returns.
nonisolated private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// One row of a query result. Valid only inside the `query` row closure.
nonisolated struct SQLiteRow {
    fileprivate let statement: OpaquePointer

    func isNull(_ index: Int32) -> Bool { sqlite3_column_type(statement, index) == SQLITE_NULL }
    func int64(_ index: Int32) -> Int64 { sqlite3_column_int64(statement, index) }
    func int(_ index: Int32) -> Int { Int(sqlite3_column_int64(statement, index)) }
    func double(_ index: Int32) -> Double { sqlite3_column_double(statement, index) }

    func text(_ index: Int32) -> String? {
        guard let pointer = sqlite3_column_text(statement, index) else { return nil }
        return String(cString: pointer)
    }

    func blob(_ index: Int32) -> Data? {
        guard sqlite3_column_type(statement, index) != SQLITE_NULL else { return nil }
        let count = Int(sqlite3_column_bytes(statement, index))
        guard count > 0, let pointer = sqlite3_column_blob(statement, index) else { return Data() }
        return Data(bytes: pointer, count: count)
    }
}

/// Thin synchronous SQLite wrapper. NOT thread-safe by design: every instance is confined to the
/// owning `CollectionStore`'s serial storage queue (opened with SQLITE_OPEN_NOMUTEX). All values
/// are bound through prepared statements; SQL text never contains caller data.
nonisolated final class SQLiteDatabase {
    private var handle: OpaquePointer?
    private var statements: [String: OpaquePointer] = [:]
    let path: String

    init(path: String) throws {
        self.path = path
        var db: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
        let code = sqlite3_open_v2(path, &db, flags, nil)
        guard code == SQLITE_OK, let db else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "code \(code)"
            sqlite3_close_v2(db)
            throw SQLiteError.open(message)
        }
        handle = db
        sqlite3_busy_timeout(db, 5_000)
        try execute("PRAGMA journal_mode=WAL")
        try execute("PRAGMA synchronous=FULL")
        try execute("PRAGMA foreign_keys=ON")
    }

    deinit {
        for statement in statements.values { sqlite3_finalize(statement) }
        sqlite3_close_v2(handle)
    }

    private var errorMessage: String {
        handle.map { String(cString: sqlite3_errmsg($0)) } ?? "closed"
    }

    func execute(_ sql: String) throws {
        var message: UnsafeMutablePointer<CChar>?
        let code = sqlite3_exec(handle, sql, nil, nil, &message)
        guard code == SQLITE_OK else {
            let text = message.map { String(cString: $0) } ?? errorMessage
            sqlite3_free(message)
            throw SQLiteError.exec(text, sql: sql)
        }
    }

    private func prepared(_ sql: String) throws -> OpaquePointer {
        if let cached = statements[sql] {
            sqlite3_reset(cached)
            sqlite3_clear_bindings(cached)
            return cached
        }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw SQLiteError.prepare(errorMessage, sql: sql)
        }
        statements[sql] = statement
        return statement
    }

    private func bind(_ values: [SQLiteValue], to statement: OpaquePointer) throws {
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let code: Int32
            switch value {
            case let .integer(number): code = sqlite3_bind_int64(statement, index, number)
            case let .real(number): code = sqlite3_bind_double(statement, index, number)
            case let .text(string): code = sqlite3_bind_text(statement, index, string, -1, sqliteTransient)
            case let .blob(data):
                code = data.withUnsafeBytes { buffer in
                    // A zero-length blob still binds as a (non-NULL) empty blob.
                    sqlite3_bind_blob(statement, index, buffer.baseAddress ?? UnsafeRawPointer(bitPattern: 1), Int32(buffer.count), sqliteTransient)
                }
            case .null: code = sqlite3_bind_null(statement, index)
            }
            guard code == SQLITE_OK else { throw SQLiteError.bind(errorMessage) }
        }
    }

    /// Runs a statement that returns no rows. Returns the number of changed rows.
    @discardableResult
    func run(_ sql: String, _ values: [SQLiteValue] = []) throws -> Int {
        let statement = try prepared(sql)
        defer { sqlite3_reset(statement) }
        try bind(values, to: statement)
        let code = sqlite3_step(statement)
        guard code == SQLITE_DONE || code == SQLITE_ROW else {
            throw SQLiteError.step(errorMessage, code: code)
        }
        return Int(sqlite3_changes(handle))
    }

    func query<T>(_ sql: String, _ values: [SQLiteValue] = [], _ row: (SQLiteRow) throws -> T) throws -> [T] {
        let statement = try prepared(sql)
        defer { sqlite3_reset(statement) }
        try bind(values, to: statement)
        var results: [T] = []
        while true {
            let code = sqlite3_step(statement)
            if code == SQLITE_DONE { break }
            guard code == SQLITE_ROW else { throw SQLiteError.step(errorMessage, code: code) }
            results.append(try row(SQLiteRow(statement: statement)))
        }
        return results
    }

    func queryOne<T>(_ sql: String, _ values: [SQLiteValue] = [], _ row: (SQLiteRow) throws -> T) throws -> T? {
        try query(sql, values, row).first
    }

    var lastInsertRowID: Int64 { sqlite3_last_insert_rowid(handle) }

    /// `BEGIN IMMEDIATE` … `COMMIT`; any thrown error rolls the whole transaction back.
    func transaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    var userVersion: Int {
        get { (try? queryOne("PRAGMA user_version") { $0.int(0) }) ?? 0 }
    }

    func setUserVersion(_ version: Int) throws {
        try execute("PRAGMA user_version=\(version)")
    }

    func integrityCheck() throws -> String {
        try queryOne("PRAGMA quick_check") { $0.text(0) ?? "" } ?? ""
    }
}
