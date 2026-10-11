<script lang="ts">
type Order = { id: string; customer: string; paid: boolean };
const props = defineProps<{ orders: readonly Order[] }>();
const paid = computed(() => props.orders.filter(({ paid }) => paid));
</script>

<template>
  <ul>
    <li v-for="{ id, customer } in paid" :key="id" @click="$emit('select', id)">
      {{ `${customer}: ${id}` }}
    </li>
  </ul>
</template>

<style lang="scss" scoped>
.orders {
  color: #2563eb;
  .paid { font-weight: 700; }
}
</style>
