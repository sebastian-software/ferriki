<script setup lang="ts">
import { computed, ref } from "vue";
interface Order {
  id: string;
  customer: string;
  total: number;
  paid: boolean;
}
const props = defineProps<{ orders: Order[] }>();
const emit = defineEmits<{ select: [id: string] }>();
const query = ref("");
const visible = computed(() =>
  props.orders.filter((order) => order.customer.includes(query.value)),
);
const total = computed(() => visible.value.reduce((sum, order) => sum + order.total, 0));
</script>

<template>
  <!-- TypeScript, Vue directives and an embedded SCSS style block. -->
  <section class="orders">
    <h1>München &amp; café</h1>
    <input v-model="query" aria-label="Search customers" />
    <ul v-if="visible.length">
      <li
        v-for="order in visible"
        :key="order.id"
        :class="{ paid: order.paid }"
        @click="emit('select', order.id)"
      >
        <strong>{{ order.customer }}</strong
        ><span>€{{ order.total.toFixed(2) }}</span>
      </li>
    </ul>
    <p v-else>No orders matching &lt;{{ query }}&gt;.</p>
    <output>€{{ total.toFixed(2) }}</output>
  </section>
</template>

<style scoped lang="scss">
$accent: #2563eb;
.orders {
  display: grid;
  gap: 1rem;
  .paid {
    color: $accent;
    &:hover {
      text-decoration: underline;
    }
  }
}
</style>
