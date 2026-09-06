/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::sync::Arc;

use crate::state_stack::{StateStack, StateStackFrame};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StackDiff {
    pub pops: usize,
    pub new_frames: Vec<StateStackFrame>,
}

#[must_use]
pub fn diff_state_stacks_ref_eq(first: &Arc<StateStack>, second: &Arc<StateStack>) -> StackDiff {
    let mut pops = 0;
    let mut new_frames = Vec::new();
    let mut current_first = Some(Arc::clone(first));
    let mut current_second = Some(Arc::clone(second));

    while !option_ref_eq(&current_first, &current_second) {
        if current_first.as_ref().is_some_and(|first| {
            current_second
                .as_ref()
                .is_none_or(|second| first.depth >= second.depth)
        }) {
            pops += 1;
            current_first = current_first
                .as_ref()
                .and_then(|stack| stack.parent.clone());
        } else {
            let second = current_second
                .as_ref()
                .expect("second stack must exist when first cannot be popped");
            new_frames.push(second.to_frame());
            current_second = second.parent.clone();
        }
    }
    new_frames.reverse();
    StackDiff { pops, new_frames }
}

#[must_use]
pub fn apply_state_stack_diff(
    stack: Option<Arc<StateStack>>,
    diff: &StackDiff,
) -> Option<Arc<StateStack>> {
    let mut current_stack = stack;
    for _ in 0..diff.pops {
        current_stack = current_stack
            .expect("state stack diff contains too many pops")
            .parent
            .clone();
    }
    for frame in &diff.new_frames {
        current_stack = Some(StateStack::push_frame(current_stack, frame));
    }
    current_stack
}

fn option_ref_eq(left: &Option<Arc<StateStack>>, right: &Option<Arc<StateStack>>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => Arc::ptr_eq(left, right),
        (None, None) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{StackDiff, apply_state_stack_diff, diff_state_stacks_ref_eq};
    use crate::{RuleId, StateStack};

    fn root(rule_id: u32) -> Arc<StateStack> {
        StateStack::new(None, RuleId::new(rule_id), -1, -1, false, None, None, None)
    }

    #[test]
    fn diffs_from_the_shared_reference_ancestor() {
        let root = root(1);
        let first = root.push(RuleId::new(2), 1, 0, false, None, None, None);
        let second = root
            .push(RuleId::new(3), 2, 1, false, None, None, None)
            .push(RuleId::new(4), 3, 2, true, Some("end".into()), None, None);

        let diff = diff_state_stacks_ref_eq(&first, &second);
        let applied = apply_state_stack_diff(Some(first), &diff).unwrap();

        assert_eq!(diff.pops, 1);
        assert_eq!(diff.new_frames.len(), 2);
        assert!(applied.equals(&second));
    }

    #[test]
    fn rebuilds_structurally_equal_stacks_without_shared_references() {
        let first = root(1).push(RuleId::new(2), 1, 0, false, None, None, None);
        let second = root(1).push(RuleId::new(2), 7, 5, false, None, None, None);

        let diff = diff_state_stacks_ref_eq(&first, &second);
        let applied = apply_state_stack_diff(Some(first), &diff).unwrap();

        assert_eq!(diff.pops, 2);
        assert_eq!(diff.new_frames.len(), 2);
        assert!(applied.equals(&second));
    }

    #[test]
    fn applies_diffs_to_and_from_empty_stacks() {
        let stack = root(1);
        let remove = StackDiff {
            pops: 1,
            new_frames: Vec::new(),
        };
        let empty = apply_state_stack_diff(Some(Arc::clone(&stack)), &remove);
        assert!(empty.is_none());

        let restore = StackDiff {
            pops: 0,
            new_frames: vec![stack.to_frame()],
        };
        assert!(
            apply_state_stack_diff(empty, &restore)
                .unwrap()
                .equals(&stack)
        );
    }
}
