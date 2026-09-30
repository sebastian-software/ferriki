//! Experimental raw-scope export for the class-highlighting comparison.
//! Run through node/experiments/class-highlighting/run.mjs, not as a product API.

use std::collections::BTreeMap;
use std::io::{self, Read};

use ferriki_textmate::__oracle::{GrammarProvider, GrammarStore, Theme};
use ferriki_textmate::{Grammar, GrammarConfiguration};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Input {
    grammars: Vec<Value>,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    id: String,
    scope: String,
    code: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut source = String::new();
    io::stdin().read_to_string(&mut source)?;
    let input: Input = serde_json::from_str(&source)?;
    let mut store = GrammarStore::new();
    let mut injections: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for value in input.grammars {
        let grammar: ferriki_textmate::RawGrammar = serde_json::from_value(value.clone())?;
        if let Some(targets) = value.get("injectTo").and_then(Value::as_array) {
            for target in targets.iter().filter_map(Value::as_str) {
                injections
                    .entry(target.to_owned())
                    .or_default()
                    .push(grammar.scope_name.clone());
            }
        }
        store.insert(grammar);
    }
    for (scope, scopes) in injections {
        store.set_injections(scope, scopes);
    }
    let mut output = Vec::new();
    for case in input.cases {
        let raw = store.lookup(&case.scope).ok_or("Missing case grammar")?;
        let grammar = Grammar::new(
            &raw,
            &store,
            Theme::create_from_raw_theme(None, None)?,
            GrammarConfiguration::default(),
        );
        let mut state = None;
        let mut lines = Vec::new();
        for line in case.code.split('\n') {
            let result = grammar.tokenize_line(line, state, 0)?;
            let length = line.encode_utf16().count();
            let tokens: Vec<_> = result
                .tokens
                .iter()
                .filter_map(|token| {
                    let end = token.end_index.min(length);
                    (token.start_index < end).then(|| {
                        json!({
                            "start": token.start_index,
                            "end": end,
                            "scopes": token.scopes,
                        })
                    })
                })
                .collect();
            lines.push(tokens);
            state = Some(result.rule_stack);
        }
        output.push(json!({ "id": case.id, "lines": lines }));
    }
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
