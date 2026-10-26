// generates the engine script to a file for python syntax validation
#include "../src/core/notebook_template.h"
#include "../src/core/settings.h"
#include <fstream>
#include <iostream>

int main(int argc, char** argv) {
    shuggle::EngineSettings es;
    es.model.context_tokens = 65536;
    es.sync_owner = "hakoradev";
    es.sync_dataset_slug = "shuggle-sync";
    std::string out_path = argc > 1 ? argv[1] : "/home/z/my-project/research/engine_script_test.py";
    auto script = shuggle::generate_engine_script(es, "testkey123456");
    std::ofstream f(out_path);
    f << script;
    std::cout << "written " << script.size() << " bytes to " << out_path << "\n";
    return 0;
}
