import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { Diagram } from '../../domain/diagram';
import { OPENAI_API_KEY } from '@/lib/env';
import { DatabaseType } from '@/lib/domain/database-type';

const openai = createOpenAI({
    apiKey: OPENAI_API_KEY,
});

export const exportBaseSQL = (diagram: Diagram): string => {
    const { tables, relationships } = diagram;

    if (!tables || tables.length === 0) {
        return '';
    }

    // Filter out the tables that are views
    const nonViewTables = tables.filter((table) => !table.isView);

    // Align the data types based on foreign key relationships
    alignForeignKeyDataTypes(diagram);

    // Initialize the SQL script string
    let sqlScript = '';

    // Loop through each non-view table to generate the SQL statements
    nonViewTables.forEach((table) => {
        sqlScript += `CREATE TABLE ${table.name} (\n`;

        table.fields.forEach((field, index) => {
            sqlScript += `  ${field.name} ${field.type}`;

            // Add size for character types
            if (field.characterMaximumLength) {
                sqlScript += `(${field.characterMaximumLength})`;
            }

            // Add precision and scale for numeric types
            if (field.precision && field.scale) {
                sqlScript += `(${field.precision}, ${field.scale})`;
            } else if (field.precision) {
                sqlScript += `(${field.precision})`;
            }

            // Handle NOT NULL constraint
            if (!field.nullable) {
                sqlScript += ' NOT NULL';
            }

            // Handle DEFAULT value
            if (field.default) {
                sqlScript += ` DEFAULT ${field.default}`;
            }

            // Handle PRIMARY KEY constraint
            if (field.primaryKey) {
                sqlScript += ' PRIMARY KEY';
            }

            // Add a comma after each field except the last one
            if (index < table.fields.length - 1) {
                sqlScript += ',\n';
            }
        });

        sqlScript += '\n);\n\n';

        // Generate SQL for indexes
        table.indexes.forEach((index) => {
            const fieldNames = index.fieldIds
                .map(
                    (fieldId) =>
                        table.fields.find((field) => field.id === fieldId)?.name
                )
                .filter(Boolean)
                .join(', ');

            if (fieldNames) {
                sqlScript += `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${index.name} ON ${table.name} (${fieldNames});\n`;
            }
        });

        sqlScript += '\n';
    });

    // Handle relationships (foreign keys)
    relationships?.forEach((relationship) => {
        const sourceTable = nonViewTables.find(
            (table) => table.id === relationship.sourceTableId
        );
        const targetTable = nonViewTables.find(
            (table) => table.id === relationship.targetTableId
        );

        const sourceTableField = sourceTable?.fields.find(
            (field) => field.id === relationship.sourceFieldId
        );
        const targetTableField = targetTable?.fields.find(
            (field) => field.id === relationship.targetFieldId
        );

        if (
            sourceTable &&
            targetTable &&
            sourceTableField &&
            targetTableField
        ) {
            sqlScript += `ALTER TABLE ${sourceTable.name} ADD CONSTRAINT ${relationship.name} FOREIGN KEY (${sourceTableField.name}) REFERENCES ${targetTable.name} (${targetTableField.name});\n`;
        }
    });

    return sqlScript;
};

export const exportSQL = async (
    diagram: Diagram,
    databaseType: DatabaseType
): Promise<string> => {
    const sqlScript = exportBaseSQL(diagram);
    const prompt = generateSQLPrompt(databaseType, sqlScript);

    const { text } = await generateText({
        model: openai('gpt-4o-mini-2024-07-18'),
        prompt: prompt,
    });

    return text;
};

function getMySQLDataTypeSize(type: string) {
    return (
        {
            tinyint: 1,
            smallint: 2,
            mediumint: 3,
            integer: 4,
            bigint: 8,
            float: 4,
            double: 8,
            decimal: 16,
            numeric: 16,
            // Add other relevant data types if needed
        }[type.toLowerCase()] || 0
    );
}

function alignForeignKeyDataTypes(diagram: Diagram) {
    const { tables, relationships } = diagram;

    if (
        !tables ||
        tables.length === 0 ||
        !relationships ||
        relationships.length === 0
    ) {
        return;
    }

    // Convert tables to a map for quick lookup
    const tableMap = new Map();
    tables.forEach((table) => {
        tableMap.set(table.id, table);
    });

    // Iterate through each relationship to update the child table column data types
    relationships.forEach((relationship) => {
        const { sourceTableId, sourceFieldId, targetTableId, targetFieldId } =
            relationship;

        const sourceTable = tableMap.get(sourceTableId);
        const targetTable = tableMap.get(targetTableId);

        if (sourceTable && targetTable) {
            const sourceField = sourceTable.fields.find(
                (field: { id: string }) => field.id === sourceFieldId
            );
            const targetField = targetTable.fields.find(
                (field: { id: string }) => field.id === targetFieldId
            );

            if (sourceField && targetField) {
                const sourceSize = getMySQLDataTypeSize(sourceField.type);
                const targetSize = getMySQLDataTypeSize(targetField.type);

                if (sourceSize > targetSize) {
                    // Adjust the child field data type to the larger data type
                    targetField.type = sourceField.type;
                } else if (targetSize > sourceSize) {
                    // Adjust the child field data type to the larger data type
                    sourceField.type = targetField.type;
                }
            }
        }
    });
}

const generateSQLPrompt = (databaseType: string, sqlScript: string) => {
    const basePrompt = `
        You are generating SQL scripts for creating database tables and sequences, handling primary keys, indices, and other table attributes.
        The following instructions will guide you in optimizing the scripts for the ${databaseType} dialect:
        - **Column Names**: Do **not** modify the names of columns. Ensure that all column names in the generated SQL script are exactly as provided in the input schema. If the input specifies a column name, it must appear in the output script unchanged.
        - **Column Name Conflicts**: When a column name conflicts with a data type or reserved keyword (e.g., fulltext), escape the column name by enclosing it.
    `;

    const dialectInstructions =
        {
            POSTGRESQL: `
        - **Sequence Creation**: Use \`CREATE SEQUENCE IF NOT EXISTS\` for sequence creation.
        - **Table and Index Creation**: Use \`CREATE TABLE IF NOT EXISTS\` and \`CREATE INDEX IF NOT EXISTS\` to avoid errors if the object already exists.
        - **Serial and Identity Columns**: For auto-increment columns, use \`SERIAL\` or \`GENERATED BY DEFAULT AS IDENTITY\`.
        - **Conditional Statements**: Utilize PostgreSQL’s support for \`IF NOT EXISTS\` in relevant \`CREATE\` statements.
    `,
            MYSQL: `
        - **Table Creation**: Use \`CREATE TABLE IF NOT EXISTS\` for creating tables. While creating the table structure, ensure that all foreign key columns use the correct data types as determined in the foreign key review.
        - **Auto-Increment**: Use \`AUTO_INCREMENT\` for auto-incrementing primary key columns.
        - **Index Creation**: Place all \`CREATE INDEX\` statements separately after the \`CREATE TABLE\` statement. Avoid using \`IF NOT EXISTS\` in \`CREATE INDEX\` statements.
        - **Indexing TEXT/BLOB Columns**: Do **not** create regular indexes on \`TEXT\` or \`BLOB\` columns. If indexing these types is required, use \`FULLTEXT\` indexes specifically for \`TEXT\` columns where appropriate, or consider alternative strategies.
        - **Date Column Defaults**: Avoid using \`CURRENT_DATE\` as a default for \`DATE\` columns. Instead, consider using \`DEFAULT NULL\` or handle default values programmatically.
        - **Timestamp Default Value**: Use \`DEFAULT CURRENT_TIMESTAMP\` for \`TIMESTAMP\` columns. Only one \`TIMESTAMP\` column can have \`CURRENT_TIMESTAMP\` as the default without specifying \`ON UPDATE\`.
        - **Boolean Columns**: Use \`TINYINT(1)\` instead of \`BOOLEAN\` for better compatibility with MySQL/MariaDB versions that might not fully support the \`BOOLEAN\` data type.
        - **TEXT and BLOB Constraints**: Do not use \`NOT NULL\` with \`TEXT\` or \`BLOB\` columns, as these types do not support the \`NOT NULL\` constraint in MariaDB.
        - **ENUM Data Type**: Ensure that default values are compatible and that the \`ENUM\` declaration adheres to MariaDB's syntax requirements.
        - **Default Values**: Ensure that default values for columns, especially \`DECIMAL\` and \`ENUM\`, are correctly formatted and comply with MariaDB's SQL syntax.
        - **Sequences**: Recognize that MySQL does not natively support sequences. Use \`AUTO_INCREMENT\` instead.

        **Reminder**: Ensure all column names that conflict with reserved keywords or data types (like \`fulltext\`) are escaped using backticks (\`).
    `,
            SQL_SERVER: `
        - **Sequence Creation**: Use \`CREATE SEQUENCE\` without \`IF NOT EXISTS\`, and employ conditional logic (\`IF NOT EXISTS\`) to check for sequence existence before creation.
        - **Identity Columns**: Always prefer using the \`IDENTITY\` keyword (e.g., \`INT IDENTITY(1,1)\`) for auto-incrementing primary key columns when possible.
        - **Conditional Logic**: Use a conditional block like \`IF NOT EXISTS (SELECT * FROM sys.objects WHERE ...)\` since SQL Server doesn’t support \`IF NOT EXISTS\` directly in \`CREATE\` statements.
        - **Avoid Unsupported Syntax**: Ensure the script does not include unsupported statements like \`CREATE TABLE IF NOT EXISTS\`.
    `,
            MARIADB: `
        - **Table Creation**: Use \`CREATE TABLE IF NOT EXISTS\` for creating tables. While creating the table structure, ensure that all foreign key columns use the correct data types as determined in the foreign key review.
        - **Auto-Increment**: Use \`AUTO_INCREMENT\` for auto-incrementing primary key columns.
        - **Index Creation**: Place all \`CREATE INDEX\` statements separately after the \`CREATE TABLE\` statement. Avoid using \`IF NOT EXISTS\` in \`CREATE INDEX\` statements.
        - **Indexing TEXT/BLOB Columns**: Do **not** create regular indexes on \`TEXT\` or \`BLOB\` columns. If indexing these types is required, use \`FULLTEXT\` indexes specifically for \`TEXT\` columns where appropriate, or consider alternative strategies.
        - **Date Column Defaults**: Avoid using \`CURRENT_DATE\` as a default for \`DATE\` columns. Instead, consider using \`DEFAULT NULL\` or handle default values programmatically.
        - **Timestamp Default Value**: Use \`DEFAULT CURRENT_TIMESTAMP\` for \`TIMESTAMP\` columns. Only one \`TIMESTAMP\` column can have \`CURRENT_TIMESTAMP\` as the default without specifying \`ON UPDATE\`.
        - **Boolean Columns**: Use \`TINYINT(1)\` instead of \`BOOLEAN\` for better compatibility with MySQL/MariaDB versions that might not fully support the \`BOOLEAN\` data type.
        - **TEXT and BLOB Constraints**: Do not use \`NOT NULL\` with \`TEXT\` or \`BLOB\` columns, as these types do not support the \`NOT NULL\` constraint in MariaDB.
        - **ENUM Data Type**: Ensure that default values are compatible and that the \`ENUM\` declaration adheres to MariaDB's syntax requirements.
        - **Default Values**: Ensure that default values for columns, especially \`DECIMAL\` and \`ENUM\`, are correctly formatted and comply with MariaDB's SQL syntax.
        - **Sequences**: Recognize that MySQL does not natively support sequences. Use \`AUTO_INCREMENT\` instead.

        **Reminder**: Ensure all column names that conflict with reserved keywords or data types (like \`fulltext\`) are escaped using backticks (\`).
        `,
            SQLITE: `
        - **Table Creation**: Use \`CREATE TABLE IF NOT EXISTS\`.
        - **Auto-Increment**: Use \`AUTOINCREMENT\` with \`INTEGER PRIMARY KEY\` for auto-increment functionality.
        - **No Sequence Support**: SQLite does not support sequences; rely solely on \`AUTOINCREMENT\` for similar functionality.
        - **Foreign Key Constraints**: Do not use \`ALTER TABLE\` to add foreign key constraints. SQLite does not support adding foreign keys to an existing table after it has been created. Always define foreign key constraints during the \`CREATE TABLE\` statement. Avoid using named constraints in foreign key definitions.
        - **Adding Foreign Keys to Existing Tables**: If adding a foreign key to an existing table is required, suggest creating a new table with the foreign key constraint, migrating the data, and renaming the new table to the original name.
        - **General SQLite Constraints**: Remember, \`ALTER TABLE\` in SQLite is limited and cannot add constraints after the table is created.
        - **Conditional Logic**: Ensure the script uses SQLite-compatible syntax and does not include unsupported features.
    `,
        }[databaseType] || '';

    const additionalInstructions = `
    Just answer with the script with no additional details. give the commands flat without markdown.

    No images are allowed. Do not try to generate or link images, including base64 data URLs.

    Feel free to suggest corrections for suspected typos.
    `;

    return `${basePrompt}\n${dialectInstructions}\n
        - **Validation**: After generating the script, validate it against the respective SQL dialect by attempting to execute it in a corresponding database environment.
        - **Syntax Checking**: Use SQL linting tools specific to each dialect to ensure the script is free from syntax errors.
        - **Manual Review**: Include a step where a knowledgeable developer reviews the generated script to ensure it meets the required specifications and adheres to best practices.

        Here is the SQL script that needs to be optimized or generated according to the instructions above:

        ${sqlScript}

        ${additionalInstructions}
    `;
};
