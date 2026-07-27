/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::fmt;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Arc, OnceLock};

use crate::attributed_scope_stack::{AttributedScopeStack, AttributedScopeStackFrame};
use crate::raw_grammar::RuleId;
use crate::rule::{Rule, RuleRegistry};

pub struct StateStack {
    pub parent: Option<Arc<Self>>,
    rule_id: RuleId,
    enter_pos: AtomicIsize,
    anchor_pos: AtomicIsize,
    pub begin_rule_captured_eol: bool,
    pub end_rule: Option<String>,
    pub name_scopes_list: Option<Arc<AttributedScopeStack>>,
    pub content_name_scopes_list: Option<Arc<AttributedScopeStack>>,
    pub depth: usize,
}

impl StateStack {
    #[must_use]
    pub fn null() -> Arc<Self> {
        static NULL: OnceLock<Arc<StateStack>> = OnceLock::new();
        Arc::clone(
            NULL.get_or_init(|| Self::new(None, RuleId::new(0), 0, 0, false, None, None, None)),
        )
    }

    #[must_use]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        parent: Option<Arc<Self>>,
        rule_id: RuleId,
        enter_pos: isize,
        anchor_pos: isize,
        begin_rule_captured_eol: bool,
        end_rule: Option<String>,
        name_scopes_list: Option<Arc<AttributedScopeStack>>,
        content_name_scopes_list: Option<Arc<AttributedScopeStack>>,
    ) -> Arc<Self> {
        let depth = parent.as_ref().map_or(1, |parent| parent.depth + 1);
        Arc::new(Self {
            parent,
            rule_id,
            enter_pos: AtomicIsize::new(enter_pos),
            anchor_pos: AtomicIsize::new(anchor_pos),
            begin_rule_captured_eol,
            end_rule,
            name_scopes_list,
            content_name_scopes_list,
            depth,
        })
    }

    #[must_use]
    pub const fn rule_id(&self) -> RuleId {
        self.rule_id
    }

    #[must_use]
    pub fn equals(self: &Arc<Self>, other: &Arc<Self>) -> bool {
        if Arc::ptr_eq(self, other) {
            return true;
        }
        structural_equals(Some(self), Some(other))
            && AttributedScopeStack::equals(
                self.content_name_scopes_list.as_ref(),
                other.content_name_scopes_list.as_ref(),
            )
    }

    #[must_use]
    pub fn clone_stack(self: &Arc<Self>) -> Arc<Self> {
        Arc::clone(self)
    }

    pub fn reset(self: &Arc<Self>) {
        let mut current = Some(Arc::clone(self));
        while let Some(element) = current {
            element.enter_pos.store(-1, Ordering::Relaxed);
            element.anchor_pos.store(-1, Ordering::Relaxed);
            current = element.parent.clone();
        }
    }

    #[must_use]
    pub fn pop(&self) -> Option<Arc<Self>> {
        self.parent.clone()
    }

    #[must_use]
    pub fn safe_pop(self: &Arc<Self>) -> Arc<Self> {
        self.parent
            .as_ref()
            .map_or_else(|| Arc::clone(self), Arc::clone)
    }

    #[must_use]
    #[allow(clippy::too_many_arguments)]
    pub fn push(
        self: &Arc<Self>,
        rule_id: RuleId,
        enter_pos: isize,
        anchor_pos: isize,
        begin_rule_captured_eol: bool,
        end_rule: Option<String>,
        name_scopes_list: Option<Arc<AttributedScopeStack>>,
        content_name_scopes_list: Option<Arc<AttributedScopeStack>>,
    ) -> Arc<Self> {
        Self::new(
            Some(Arc::clone(self)),
            rule_id,
            enter_pos,
            anchor_pos,
            begin_rule_captured_eol,
            end_rule,
            name_scopes_list,
            content_name_scopes_list,
        )
    }

    #[must_use]
    pub fn enter_pos(&self) -> isize {
        self.enter_pos.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn anchor_pos(&self) -> isize {
        self.anchor_pos.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn rule<'a>(&self, registry: &'a RuleRegistry) -> &'a Rule {
        registry.get_rule(self.rule_id)
    }

    #[must_use]
    pub fn with_content_name_scopes_list(
        self: &Arc<Self>,
        content_name_scope_stack: Arc<AttributedScopeStack>,
    ) -> Arc<Self> {
        if self
            .content_name_scopes_list
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &content_name_scope_stack))
        {
            return Arc::clone(self);
        }
        self.parent
            .as_ref()
            .expect("root state cannot replace its content-name scope stack")
            .push(
                self.rule_id,
                self.enter_pos(),
                self.anchor_pos(),
                self.begin_rule_captured_eol,
                self.end_rule.clone(),
                self.name_scopes_list.clone(),
                Some(content_name_scope_stack),
            )
    }

    #[must_use]
    pub fn with_end_rule(self: &Arc<Self>, end_rule: impl Into<String>) -> Arc<Self> {
        let end_rule = end_rule.into();
        if self.end_rule.as_deref() == Some(&end_rule) {
            return Arc::clone(self);
        }
        Self::new(
            self.parent.clone(),
            self.rule_id,
            self.enter_pos(),
            self.anchor_pos(),
            self.begin_rule_captured_eol,
            Some(end_rule),
            self.name_scopes_list.clone(),
            self.content_name_scopes_list.clone(),
        )
    }

    #[must_use]
    pub fn has_same_rule_as(&self, other: &Self) -> bool {
        let mut current = Some(self);
        while let Some(element) = current {
            if element.enter_pos() != other.enter_pos() {
                break;
            }
            if element.rule_id == other.rule_id {
                return true;
            }
            current = element.parent.as_deref();
        }
        false
    }

    #[must_use]
    pub fn to_frame(self: &Arc<Self>) -> StateStackFrame {
        StateStackFrame {
            rule_id: self.rule_id.get(),
            enter_pos: None,
            anchor_pos: None,
            begin_rule_captured_eol: self.begin_rule_captured_eol,
            end_rule: self.end_rule.clone(),
            name_scopes_list: self
                .name_scopes_list
                .as_ref()
                .and_then(|scopes| {
                    scopes.extension_if_defined(
                        self.parent
                            .as_ref()
                            .and_then(|parent| parent.name_scopes_list.as_ref()),
                    )
                })
                .unwrap_or_default(),
            content_name_scopes_list: self
                .content_name_scopes_list
                .as_ref()
                .and_then(|scopes| scopes.extension_if_defined(self.name_scopes_list.as_ref()))
                .unwrap_or_default(),
        }
    }

    #[must_use]
    pub fn push_frame(parent: Option<Arc<Self>>, frame: &StateStackFrame) -> Arc<Self> {
        let names_scope_list = AttributedScopeStack::from_extension(
            parent
                .as_ref()
                .and_then(|parent| parent.name_scopes_list.clone()),
            &frame.name_scopes_list,
        );
        let content_name_scopes_list = AttributedScopeStack::from_extension(
            names_scope_list.clone(),
            &frame.content_name_scopes_list,
        );
        Self::new(
            parent,
            RuleId::new(frame.rule_id),
            frame.enter_pos.unwrap_or(-1),
            frame.anchor_pos.unwrap_or(-1),
            frame.begin_rule_captured_eol,
            frame.end_rule.clone(),
            names_scope_list,
            content_name_scopes_list,
        )
    }
}

impl fmt::Display for StateStack {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut elements = Vec::new();
        let mut current = Some(self);
        while let Some(element) = current {
            elements.push(format!(
                "({}, {}, {})",
                element.rule_id.get(),
                element
                    .name_scopes_list
                    .as_ref()
                    .map_or_else(|| "undefined".to_owned(), ToString::to_string),
                element
                    .content_name_scopes_list
                    .as_ref()
                    .map_or_else(|| "undefined".to_owned(), ToString::to_string),
            ));
            current = element.parent.as_deref();
        }
        elements.reverse();
        write!(formatter, "[{}]", elements.join(","))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StateStackFrame {
    pub rule_id: u32,
    pub enter_pos: Option<isize>,
    pub anchor_pos: Option<isize>,
    pub begin_rule_captured_eol: bool,
    pub end_rule: Option<String>,
    pub name_scopes_list: Vec<AttributedScopeStackFrame>,
    pub content_name_scopes_list: Vec<AttributedScopeStackFrame>,
}

fn structural_equals(left: Option<&Arc<StateStack>>, right: Option<&Arc<StateStack>>) -> bool {
    let mut left = left.cloned();
    let mut right = right.cloned();
    loop {
        match (left.as_ref(), right.as_ref()) {
            (Some(left_stack), Some(right_stack)) => {
                if Arc::ptr_eq(left_stack, right_stack) {
                    return true;
                }
                if left_stack.depth != right_stack.depth
                    || left_stack.rule_id != right_stack.rule_id
                    || left_stack.end_rule != right_stack.end_rule
                {
                    return false;
                }
                left = left_stack.parent.clone();
                right = right_stack.parent.clone();
            }
            (None, None) => return true,
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::StateStack;
    use crate::{AttributedScopeStack, EncodedTokenAttributes, FontAttribute, RuleId};

    fn scopes(name: &str, metadata: u32) -> Arc<AttributedScopeStack> {
        AttributedScopeStack::create_root(
            name,
            EncodedTokenAttributes::new(metadata),
            FontAttribute::default(),
        )
    }

    #[test]
    fn pushes_pops_and_resets_line_positions() {
        let root = StateStack::new(None, RuleId::new(1), 3, 2, false, None, None, None);
        let child = root.push(RuleId::new(2), 7, 5, true, Some("end".into()), None, None);

        assert_eq!(child.depth, 2);
        assert!(Arc::ptr_eq(&child.pop().unwrap(), &root));
        assert!(Arc::ptr_eq(&root.safe_pop(), &root));
        assert_eq!(child.enter_pos(), 7);
        assert_eq!(child.anchor_pos(), 5);
        assert_eq!(
            child.to_string(),
            "[(1, undefined, undefined),(2, undefined, undefined)]"
        );

        child.reset();
        assert_eq!(child.enter_pos(), -1);
        assert_eq!(root.enter_pos(), -1);
        assert_eq!(root.anchor_pos(), -1);
    }

    #[test]
    fn equality_ignores_positions_but_compares_rules_ends_and_scopes() {
        let first_root = StateStack::new(
            None,
            RuleId::new(1),
            1,
            1,
            false,
            None,
            None,
            Some(scopes("source.test", 1)),
        );
        let second_root = StateStack::new(
            None,
            RuleId::new(1),
            99,
            42,
            false,
            None,
            None,
            Some(scopes("source.test", 1)),
        );
        assert!(first_root.equals(&second_root));

        let different_scope = StateStack::new(
            None,
            RuleId::new(1),
            1,
            1,
            false,
            None,
            None,
            Some(scopes("source.test", 2)),
        );
        assert!(!first_root.equals(&different_scope));

        let different_end = second_root.with_end_rule("end");
        assert!(!first_root.equals(&different_end));
    }

    #[test]
    fn updates_end_and_content_scopes_persistently() {
        let root_scopes = scopes("source.test", 1);
        let root = StateStack::new(
            None,
            RuleId::new(1),
            0,
            0,
            false,
            None,
            Some(Arc::clone(&root_scopes)),
            Some(Arc::clone(&root_scopes)),
        );
        let child = root.push(
            RuleId::new(2),
            2,
            1,
            false,
            Some("old".into()),
            Some(Arc::clone(&root_scopes)),
            Some(Arc::clone(&root_scopes)),
        );
        let new_content = scopes("source.content", 2);
        let updated = child
            .with_content_name_scopes_list(Arc::clone(&new_content))
            .with_end_rule("new");

        assert!(Arc::ptr_eq(updated.parent.as_ref().unwrap(), &root));
        assert_eq!(updated.end_rule.as_deref(), Some("new"));
        assert!(Arc::ptr_eq(
            updated.content_name_scopes_list.as_ref().unwrap(),
            &new_content
        ));
        assert!(Arc::ptr_eq(&updated.with_end_rule("new"), &updated));
    }

    #[test]
    fn detects_same_rules_at_the_same_enter_position() {
        let root = StateStack::new(None, RuleId::new(1), 4, 0, false, None, None, None);
        let middle = root.push(RuleId::new(2), 4, 0, false, None, None, None);
        let current = middle.push(RuleId::new(3), 4, 0, false, None, None, None);
        let repeated = StateStack::new(None, RuleId::new(1), 4, 0, false, None, None, None);
        let other_position = StateStack::new(None, RuleId::new(1), 5, 0, false, None, None, None);

        assert!(current.has_same_rule_as(&repeated));
        assert!(!current.has_same_rule_as(&other_position));
    }

    #[test]
    fn roundtrips_state_stack_frames() {
        let name = scopes("source.test", 1);
        let content = AttributedScopeStack::from_extension(
            Some(Arc::clone(&name)),
            &[crate::AttributedScopeStackFrame {
                encoded_token_attributes: EncodedTokenAttributes::new(2),
                scope_names: vec!["meta.block".into()],
            }],
        )
        .unwrap();
        let state = StateStack::new(
            None,
            RuleId::new(7),
            3,
            2,
            true,
            Some("end".into()),
            Some(name),
            Some(content),
        );
        let frame = state.to_frame();
        let rebuilt = StateStack::push_frame(None, &frame);

        assert!(state.equals(&rebuilt));
        assert_eq!(rebuilt.enter_pos(), -1);
        assert_eq!(rebuilt.anchor_pos(), -1);
        assert_eq!(frame.rule_id, 7);
    }
}
