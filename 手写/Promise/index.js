console.log("1");

setTimeout(() => {
  console.log("2");

  Promise.resolve()
    .then(() => {
      console.log("3");

      queueMicrotask(() => {
        console.log("4");
      });

      return Promise.resolve().then(() => {
        console.log("5");
      });
    })
    .then(() => {
      console.log("6");
    });

  queueMicrotask(() => {
    console.log("7");
  });

  console.log("8");
}, 0);

(async function () {
  console.log("9");

  await null;

  console.log("10");

  queueMicrotask(() => {
    console.log("11");
  });

  await Promise.resolve();

  console.log("12");
})();

Promise.resolve()
  .then(() => {
    console.log("13");

    setTimeout(() => {
      console.log("14");
    }, 0);

    return {
      then(resolve) {
        console.log("15");

        resolve("result");

        queueMicrotask(() => {
          console.log("16");
        });
      },
    };
  })
  .then((value) => {
    console.log("17", value);
  });

queueMicrotask(() => {
  console.log("18");

  Promise.resolve().then(() => {
    console.log("19");
  });
});

console.log("20");
