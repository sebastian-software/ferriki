<script lang="ts">
  type Order = { id: string; customer: string; total: number; paid: boolean };
  let { orders = [] }: { orders: Order[] } = $props();
  let query = $state("");
  let visible = $derived(orders.filter((order) => order.customer.includes(query)));
  let total = $derived(visible.reduce((sum, order) => sum + order.total, 0));
</script>

<!-- Reactive TypeScript, control blocks, bindings and scoped styles. -->
<section class="orders">
  <h1>München &amp; café</h1>
  <label>Search <input bind:value={query} placeholder="Customer…" /></label>
  {#if visible.length > 0}
    <ul>
      {#each visible as order (order.id)}
        <li class:paid={order.paid}>
          <strong>{order.customer}</strong><span>€{order.total.toFixed(2)}</span>
        </li>
      {/each}
    </ul>
  {:else}
    <p>No orders matching &lt;{query}&gt;.</p>
  {/if}
  <output>€{total.toFixed(2)}</output>
</section>

<style>
  .orders { display: grid; gap: 1rem; }
  .paid { color: #2563eb; }
  @media (width < 40rem) { .orders { font-size: 0.9rem; } }
</style>
