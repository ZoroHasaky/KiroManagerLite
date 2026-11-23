<script setup lang="ts">
import NetworkCheckCard from '@/components/tools/NetworkCheckCard.vue'
</script>

<template>
  <div class="tools-page">
    <NetworkCheckCard />
  </div>
</template>

<style scoped>
.tools-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
</style>
